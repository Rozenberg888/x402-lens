/**
 * `paymentLens()` — x402 v2 payments for Hono, with observability that explains
 * itself.
 *
 * Same shape as `@x402-lens/express`: a thin layer over the official middleware
 * (`@x402/hono` here), plus an event per payment step, a readable 402 body, and
 * a diagnosis for every failure.
 *
 * Hono differs from Express in one way that matters: a middleware returns a
 * `Response` instead of mutating one. That makes observation simpler (read the
 * finished response) and makes "hand control to the SDK" explicit — the SDK
 * middleware is invoked from inside ours rather than being composed by the
 * framework.
 *
 * The framework-independent half — servers, schemes, hooks, event shaping —
 * comes from `@x402-lens/server`, shared with the Express adapter so the two
 * cannot drift apart on a payment path.
 */

import { randomUUID } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import {
  ConfigError,
  PrometheusRegistry,
  assertLensConfig,
  callbackSink,
  diagnose,
  loadConfig,
  makeEvent,
  resolveConfig,
  type EventBus,
  type LensConfig,
  type LensConfigInput,
  type LensEvent,
  type LensSink,
  type RouteInput,
  type RoutePrice,
} from "@x402-lens/core";
import type {
  FacilitatorClient,
  RoutesConfig,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@x402/core/server";
import { HonoAdapter, paymentMiddlewareFromHTTPServer } from "@x402/hono";
import {
  ACCESS_DENIED_BODY,
  FACILITATOR_UNAVAILABLE_BODY,
  MIDDLEWARE_ERROR_BODY,
  buildCorsHeaders,
  buildServers,
  emitAccess,
  emitMiddlewareError,
  emitRequired,
  matchRouteConfig,
  mergeCorsHeaders,
  runWithRequestContext,
  safeCall,
  type LensCommonOptions,
  type LensSinkOptions,
  type RequestContext,
} from "@x402-lens/server";import { observePaymentRequired } from "./observe.js";

export { ACCESS_DENIED_BODY, FACILITATOR_UNAVAILABLE_BODY, MIDDLEWARE_ERROR_BODY };
export type { LensSinkOptions };

/** Short route form: a bare price, or the full per-route options. */
export type RouteMap = Record<string, string | Omit<RouteInput, "route">>;

export interface PaymentLensOptions extends Omit<LensConfigInput, "routes"> {
  /**
   * Route prices, in either the short map form
   * (`{ "GET /weather": "$0.001" }`) or the `RouteInput[]` form. Overrides the
   * config file and `X402_PRICE__*`.
   */
  routes?: RouteMap | RouteInput[];
  /**
   * Pre-resolved config. Skips file/env loading, but still runs
   * {@link assertLensConfig} (URL, payTo, paths, schemes, headers).
   */
  config?: LensConfig;
  /** Where events go. Defaults to console. */
  sinks?: LensSinkOptions;
  /** Extra sinks, appended after the ones built from `sinks`. */
  extraSinks?: LensSink[];
  /** Override the `RoutesConfig` handed to `@x402/hono`, for advanced setups. */
  routesConfig?: RoutesConfig;
  /** Mirror the decoded challenge into the 402 JSON body. On by default. */
  readableBody?: boolean;
  /** Expose the payment headers for browser buyers. */
  cors?: boolean | { origin?: string };
  /** Replace the facilitator client entirely. */
  facilitatorClient?: FacilitatorClient;
  /**
   * Grant access without payment for a request.
   *
   * Runs before verification on every protected route. Return `true` to let the
   * handler run unpaid, or a reason string to deny with a 403. The buyer always
   * sees `{ error: "access_denied" }`; the reason is only on the event.
   *
   * Returning `false`/`undefined` continues to the normal payment flow.
   */
  grant?: (request: GrantContext) => boolean | string | undefined | Promise<boolean | string | undefined>;
}

export interface PaymentLens {
  /** Mount in Hono before your routes: `app.use("*", lens.middleware)`. */
  middleware: MiddlewareHandler;
  /** The underlying resource server, for custom hooks or extensions. */
  server: x402ResourceServer;
  /** The underlying HTTP resource server. */
  httpServer: x402HTTPResourceServer;
  /** Resolved and validated configuration. */
  config: LensConfig;
  /** Settles when the facilitator `/supported` probe succeeds. */
  ready: Promise<void>;
  /** Subscribe to events programmatically. */
  on(listener: (event: LensEvent) => void): () => void;
  /** Flush sinks and stop emitting. */
  close(): Promise<void>;
}

/** What a `grant` callback is given about the request it may let through. */
export interface GrantContext {
  method: string;
  path: string;
  /** `"<METHOD> <path>"`, the same key the route map uses. */
  route: string;
  /** Read a request header. Use it to check an API key or an internal marker. */
  header(name: string): string | undefined;
  /** Query parameters, as Hono parses them. */
  query: Record<string, string | string[]>;
  /** The matched route's configuration, when known. */
  config: RouteInput | RoutePrice | undefined;
}

/**
 * Build x402 payment middleware for Hono.
 *
 * Configuration precedence is explicit options → `X402_*` environment variables.
 * Use {@link paymentLensAsync} when it should also read `x402.config.json`.
 *
 * @param options - Routes, configuration, and sinks
 * @returns Middleware plus handles for events and the underlying servers
 * @throws {ConfigError} When a required setting is missing or malformed
 */
export function paymentLens(options: PaymentLensOptions = {}): PaymentLens {
  const config = options.config
    ? (assertLensConfig(options.config), normalisePassedConfig(options.config))
    : resolveConfig({ ...options, routes: normaliseRouteInput(options.routes) });
  return buildLens(config, options);
}

/**
 * Async variant that also reads `x402.config.json` from the working directory.
 *
 * @param options - Routes, configuration, and sinks
 * @returns Middleware plus handles for events and the underlying servers
 * @throws {ConfigError} When a required setting is missing or malformed
 */
export async function paymentLensAsync(
  options: PaymentLensOptions = {},
): Promise<PaymentLens> {
  const config = options.config
    ? (assertLensConfig(options.config), normalisePassedConfig(options.config))
    : await loadConfig({ ...options, routes: normaliseRouteInput(options.routes) });
  return buildLens(config, options);
}

/** Match `resolveConfig` trailing-slash stripping for pre-built configs. */
function normalisePassedConfig(config: LensConfig): LensConfig {
  return { ...config, facilitatorUrl: config.facilitatorUrl.replace(/\/+$/, "") };
}

function normaliseRouteInput(routes: PaymentLensOptions["routes"]): RouteInput[] | undefined {
  if (!routes) return undefined;
  if (Array.isArray(routes)) return routes;
  return Object.entries(routes).map(([route, value]) => {
    if (typeof value === "string") return { route, price: value };
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return { route, ...value };
    }
    throw new ConfigError(
      "routes",
      `routes["${route}"] must be a price string or an options object, got ${JSON.stringify(value)}.`,
    );
  });
}

function buildLens(config: LensConfig, options: PaymentLensOptions): PaymentLens {
  if (options.routesConfig && Object.keys(options.routesConfig).length === 0) {
    throw new ConfigError(
      "routesConfig",
      "routesConfig is empty. Omit it to use config.routes, or pass at least one protected route — an empty map silently disables payment protection.",
    );
  }

  const { bus, server, httpServer, ready, emitInitFailure, initFailure } = buildServers(
    config,
    options,
  );

  // Disable the SDK's parallel syncFacilitatorOnStart probe — `ready` is the
  // single source of truth for initialization.
  const inner = paymentMiddlewareFromHTTPServer(httpServer, undefined, undefined, false);

  const corsHeaders = buildCorsHeaders(options.cors);
  if (options.cors === true) {
    process.emitWarning(
      "[x402-lens] cors: true does not set Access-Control-Allow-Origin. Pass cors: { origin: \"…\" } for browser buyers.",
      "X402LensCors",
    );
  }

  const grant = options.grant;

  const middleware: MiddlewareHandler = async (c, next) => {
    const context: RequestContext = {
      requestId: randomUUID(),
      startedAt: Date.now(),
      method: c.req.method,
      path: c.req.path,
    };

    if (corsHeaders) applyCorsHeaders(c, corsHeaders);

    // Browser preflight must never hit the payment path.
    if (c.req.method === "OPTIONS") {
      if (corsHeaders) return c.body(null, 204);
      return next();
    }

    await runWithRequestContext(context, async () => {
      const adapter = new HonoAdapter(c);
      const paymentHeader =
        adapter.getHeader("payment-signature") || adapter.getHeader("x-payment");

      // Unprotected routes must not depend on facilitator readiness.
      //
      // `requiresPayment` reads the route table and can throw if the adapter
      // hands it something it cannot parse. That is a lens-side failure, not a
      // facilitator outage, so it must not escape as Hono's bare-text 500: an
      // operator needs the same `MIDDLEWARE_ERROR` JSON the Express adapter
      // sends, and a test asserts it.
      let required: boolean;
      try {
        required = httpServer.requiresPayment({
          adapter,
          path: c.req.path,
          decodedPath: decodedRoutePath(c.req.path),
          method: c.req.method,
          paymentHeader,
        });
      } catch (error) {
        const asError = error instanceof Error ? error : new Error(String(error));
        emitMiddlewareError(bus, config, context, asError);
        c.res = c.json(MIDDLEWARE_ERROR_BODY, 500);
        return;
      }

      if (!required) {
        await next();
        return;
      }

      if (grant) {
        try {
          const decision = await grant({
            method: context.method,
            path: context.path,
            route: `${context.method} ${context.path}`,
            header: (name: string) => safeCall(() => adapter.getHeader(name)),
            query: safeCall(() => adapter.getQueryParams()) ?? {},
            config: matchRouteConfig(config, context.method, context.path),
          });

          if (decision === true) {
            emitAccess(bus, config, context, "access.granted");
            await next();
            return;
          }

          if (typeof decision === "string") {
            emitAccess(bus, config, context, "access.denied", decision);
            c.res = c.json(ACCESS_DENIED_BODY, 403);
            return;
          }
        } catch (error) {
          // Truncation lives in `emitAccess`, so a thrown message and a
          // returned string are capped identically.
          const reason = error instanceof Error ? error.message : "grant_error";
          emitAccess(bus, config, context, "access.denied", reason);
          c.res = c.json(ACCESS_DENIED_BODY, 403);
          return;
        }
      }

      try {
        await ready;
      } catch (error) {
        const asError = initFailure() ?? (error instanceof Error ? error : new Error(String(error)));
        emitInitFailure(asError);
        c.res = c.json(FACILITATOR_UNAVAILABLE_BODY, 502);
        return;
      }

      // The SDK middleware either returns a Response or writes `c.res` after
      // calling `next()`. Both shapes are real: its "no payment required"
      // branch delegates to the application handler.
      try {
        const returned = await inner(c, next);
        const response =
          returned instanceof Response ? returned : (c.res ?? new Response(null, { status: 204 }));

        c.res = await observePaymentRequired(
          response,
          paymentRequired => emitRequired(bus, config, context, paymentRequired),
          { mirrorBody: options.readableBody ?? true },
        );
      } catch (error) {
        const asError = error instanceof Error ? error : new Error(String(error));
        emitMiddlewareError(bus, config, context, asError);
        c.res = c.json(FACILITATOR_UNAVAILABLE_BODY, 502);
      }
    });

    // `runWithRequestContext` returns whatever the callback returns; the
    // callback writes `c.res` itself, so there is nothing to hand back.
  };

  return {
    middleware,
    server,
    httpServer,
    config,
    ready,
    on(listener) {
      const sink = callbackSink(listener);
      bus.add(sink);
      return () => {
        bus.remove(sink);
      };
    },
    close() {
      return bus.close();
    },
  };
}

/**
 * Merge our headers into whatever the response already carries.
 *
 * Hono has no response object at this point — the headers live on `c.res` — so
 * the existing-value reader pulls from there.
 */
function applyCorsHeaders(c: Context, headers: Record<string, string>): void {
  const merged = mergeCorsHeaders(
    (name: string) => c.res.headers.get(name) ?? undefined,
    headers,
  );
  for (const [name, value] of Object.entries(merged)) {
    c.header(name, value);
  }
}

function decodedRoutePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

export { PrometheusRegistry, prometheusHandler } from "@x402-lens/core";
export type { FacilitatorClient, RoutesConfig };
export type { LensSink };
