/**
 * `paymentLens()` — x402 v2 payments for Express, with observability that
 * explains itself.
 *
 * This is a thin layer over `@x402/express`, not a reimplementation. The
 * official middleware owns the protocol: it builds `PaymentRequired`, sets
 * `PAYMENT-REQUIRED`, calls the facilitator's `/verify` and `/settle`, and
 * settles only after a successful handler. Everything here attaches to it.
 *
 * What we add:
 *
 * - An event per payment lifecycle step, with the fields needed to answer
 *   "why did this fail": route, amount, network, buyer, tx hash, plus findings.
 * - A readable 402 body next to the canonical header, so `curl | jq` works.
 * - Config loading that refuses to guess a facilitator, network, or address.
 *
 * The framework-independent half — servers, schemes, hooks, event shaping —
 * lives in `@x402-lens/server` and is shared with the Hono adapter, so the two
 * cannot drift apart on a payment path. What is left here is only the part that
 * is genuinely Express: a mutable `res`, `next()`, and the ALS binding.
 */

import { randomUUID } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
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
  HTTPRequestContext,
  RoutesConfig,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@x402/core/server";
import { ExpressAdapter, paymentMiddlewareFromHTTPServer } from "@x402/express";
import {
  ACCESS_DENIED_BODY,
  FACILITATOR_UNAVAILABLE_BODY,
  MIDDLEWARE_ERROR_BODY,
  buildCorsHeaders,
  buildServers,
  decodedRoutePath,
  emitAccess,
  emitMiddlewareError,
  emitRequired,
  matchRouteConfig,
  mergeCorsHeaders,
  normalisePassedConfig,
  normaliseRouteInput,
  pathMatchesPattern,
  runWithRequestContext,
  safeCall,
  type CustomSchemeRegistration,
  type LensSinkOptions,
  type RequestContext,
} from "@x402-lens/server";
import { observePaymentRequired } from "./observe.js";

/** Re-exported so the two adapters expose the same names for the same bodies. */
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
  /**
   * Schemes to register in addition to the ones this package ships.
   *
   * For `batch-settlement`, `auth-capture`, or a scheme newer than this release.
   * They cannot be named in configuration because they need runtime objects —
   * channel storage, an authorizer signer — so the built instance is passed here
   * instead.
   */
  extraSchemes?: CustomSchemeRegistration[];
  /** Override the `RoutesConfig` handed to `@x402/express`, for advanced setups. */
  routesConfig?: RoutesConfig;
  /**
   * Mirror the decoded challenge into the 402 JSON body. On by default: the v2
   * spec leaves the body to the server, and a readable body is the difference
   * between a debuggable endpoint and a base64 scavenger hunt.
   */
  readableBody?: boolean;
  /**
   * Expose the payment headers for browser buyers. Off by default so an app
   * with its own CORS layer is never surprised.
   *
   * Without this, a cross-origin `fetch()` cannot read `PAYMENT-REQUIRED` or
   * `PAYMENT-RESPONSE`, and the browser strips `PAYMENT-SIGNATURE` from the
   * retry — the payment silently never happens. `x402-lens inspect` reports it.
   *
   * Pass `true` to let x402-lens set the headers, or `{ origin }` to also emit
   * `Access-Control-Allow-Origin`. If your app already has a CORS middleware,
   * leave this off and add the three headers there instead.
   */
  cors?: boolean | { origin?: string };
  /**
   * Replace the facilitator client entirely.
   *
   * For a facilitator that is not plain HTTP (an in-process one, a queue-backed
   * one, a proxy that signs requests), or to wrap the SDK client with retries,
   * caching, or metrics. When supplied, `facilitatorUrl` is still validated but
   * only used for event metadata and doctor output.
   */
  facilitatorClient?: FacilitatorClient;
  /**
   * Grant access without payment for a request.
   *
   * Runs before verification on every request to a protected route. Return
   * `true` to let the handler run unpaid (health checks, internal traffic, a
   * free tier), or a reason string to deny with a 403. The buyer always sees
   * `{ error: "access_denied" }`; the reason is only on the event. Every
   * decision emits `access.granted` / `access.denied`.
   *
   * Returning `false`/`undefined` continues to the normal payment flow.
   */
  grant?: (request: GrantContext) => boolean | string | undefined | Promise<boolean | string | undefined>;
}

export interface PaymentLens {
  /** Mount in Express before your routes. */
  middleware: RequestHandler;
  /** The underlying resource server, for custom hooks or extensions. */
  server: x402ResourceServer;
  /** The underlying HTTP resource server. */
  httpServer: x402HTTPResourceServer;
  /** Resolved and validated configuration. */
  config: LensConfig;
  /**
   * Settles when the facilitator `/supported` probe succeeds.
   *
   * Rejects when the facilitator cannot be reached or advertises no usable
   * kinds. Await this before accepting traffic so a dead facilitator fails
   * the deploy instead of the first buyer's request.
   */
  ready: Promise<void>;
  /** Subscribe to events programmatically. */
  on(listener: (event: LensEvent) => void): () => void;
  /** Flush sinks and stop emitting. */
  close(): Promise<void>;
}

/** What a `grant` callback is given about the request it may let through. */
export interface GrantContext {
  /** HTTP method, e.g. `GET`. */
  method: string;
  /** Request path, e.g. `/weather`. */
  path: string;
  /** `"<METHOD> <path>"`, the same key the route map uses. */
  route: string;
  /**
   * Read a request header, case-insensitively-ish (exactly as the adapter
   * reports it). The SDK gives hooks an accessor rather than a header map, so
   * this is a function — use it to check an API key or an internal marker.
   */
  header(name: string): string | undefined;
  /** Query parameters, when the adapter can provide them. */
  query: Record<string, string | string[]>;
  /** The matched route's configuration (price, scheme, metadata), when known. */
  config: RouteInput | RoutePrice | undefined;
}

/**
 * Build x402 payment middleware for Express.
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
    : resolveConfig({
        ...options,
        routes: normaliseRouteInput(options.routes),
      });
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
    : await loadConfig({
        ...options,
        routes: normaliseRouteInput(options.routes),
      });
  return buildLens(config, options);
}

/** Match `resolveConfig` trailing-slash stripping for pre-built configs. */
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

  // Disable the SDK's parallel syncFacilitatorOnStart probe — `ready` above is
  // the single source of truth for initialization.
  const inner = paymentMiddlewareFromHTTPServer(httpServer, undefined, undefined, false);

  const corsHeaders = buildCorsHeaders(options.cors);
  if (options.cors === true) {
    process.emitWarning(
      "[x402-lens] cors: true does not set Access-Control-Allow-Origin. Pass cors: { origin: \"…\" } for browser buyers.",
      "X402LensCors",
    );
  }

  const grant = options.grant;
  const readableBody = options.readableBody ?? true;

  const middleware: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    const context: RequestContext = {
      requestId: randomUUID(),
      startedAt: Date.now(),
      method: req.method,
      path: req.path,
    };

    if (corsHeaders) applyCorsHeaders(res, corsHeaders);

    // Browser preflight must never hit the payment path (wildcard routes included).
    if (req.method === "OPTIONS") {
      // When lens owns CORS, complete preflight here — otherwise Express 404s
      // and browsers never send PAYMENT-SIGNATURE. When cors is off, the app's
      // own CORS middleware must answer.
      if (corsHeaders) {
        if (!res.headersSent) res.sendStatus(204);
        return;
      }
      next();
      return;
    }

    // Enter ALS before grant/ready so hooks share the same requestId.
    runWithRequestContext(context, () => {
      void (async () => {
        const adapter = new ExpressAdapter(req);
        const httpContext = {
          adapter,
          path: req.path,
          decodedPath: decodedRoutePath(req.path),
          method: req.method,
          paymentHeader:
            adapter.getHeader("payment-signature") || adapter.getHeader("x-payment"),
        };

        // Unprotected routes must not depend on facilitator readiness (health checks).
        if (!httpServer.requiresPayment(httpContext)) {
          // A mounted router is the one place this can go wrong silently.
          //
          // Inside `app.use('/acme', router)` Express strips the prefix, so
          // `req.path` is `/weather` and the route key must be written without
          // `/acme`. A key written with the prefix — the obvious guess — matches
          // nothing here while the app's own `router.get('/weather')` still
          // serves it, so the handler runs unpaid and answers 200. Measured:
          // key `/acme/weather` returned 200 with the protected payload, and no
          // event, no 402, no error anywhere.
          //
          // Detecting it costs one comparison: if the mounted path would have
          // matched, the key is wrong and saying so beats paying for it.
          const mountedPath = `${req.baseUrl ?? ""}${req.path}`;
          if (mountedPath !== req.path && matchesConfiguredRoute(config, req.method, mountedPath)) {
            process.emitWarning(
              `[x402-lens] route key "${req.method} ${mountedPath}" includes the mount prefix. Inside a mounted router Express reports the path without it, so this request was served unpaid. Write the key as "${req.method} ${req.path}".`,
              "X402LensConfig",
            );
          }
          next();
          return;
        }

        // Observe only from here on — after the route is known to be protected.
        //
        // It used to be attached before this check, so an unprotected route (or
        // a grant-allowed one) that answered its own 402 had its body rewritten:
        // the app sent `{"free":"yes"}` and the client received
        // `{"free":"yes","x402Version":2,"accepts":[]}`, plus a `payment.required`
        // event for a payment that was never requested. Corrupting another
        // handler's response is worse than missing an event, and the event was
        // not real either.
        observePaymentRequired(
          res,
          paymentRequired => emitRequired(bus, config, context, paymentRequired),
          { mirrorBody: readableBody },
        );

        // Grant runs before ready so internal bypass still works when the
        // facilitator is down.
        if (grant) {
          try {
            const decision = await grant({
              method: context.method,
              path: context.path,
              route: `${context.method} ${context.path}`,
              header: (name: string) => safeCall(() => adapter.getHeader(name)),
              query: safeCall(() => adapter.getQueryParams?.() ?? {}) ?? {},
              config: matchRouteConfig(config, context.method, context.path),
            });

            if (decision === true) {
              emitAccess(bus, config, context, "access.granted");
              next();
              return;
            }

            if (typeof decision === "string") {
              emitAccess(bus, config, context, "access.denied", decision);
              if (!res.headersSent) res.status(403).json(ACCESS_DENIED_BODY);
              return;
            }
          } catch (error) {
            // Truncation lives in `emitAccess`, so a thrown message and a
            // returned string are capped identically.
            const reason = error instanceof Error ? error.message : "grant_error";
            emitAccess(bus, config, context, "access.denied", reason);
            if (!res.headersSent) {
              res.status(403).json(ACCESS_DENIED_BODY);
            }
            return;
          }
        }

        try {
          await ready;
        } catch (error) {
          const asError =
            initFailure() ??
            (error instanceof Error ? error : new Error(String(error)));
          emitInitFailure(asError);
          if (!res.headersSent) {
            res.status(502).json(FACILITATOR_UNAVAILABLE_BODY);
          } else if (!res.writableEnded) {
            res.end();
          }
          return;
        }

        void Promise.resolve(inner(req, res, next)).catch((error: unknown) => {
          const asError = error instanceof Error ? error : new Error(String(error));
          emitMiddlewareError(bus, config, context, asError);
          if (!res.headersSent) {
            res.status(500).json(MIDDLEWARE_ERROR_BODY);
          } else if (!res.writableEnded) {
            res.end();
          }
        });
      })().catch((error: unknown) => {
        const asError = error instanceof Error ? error : new Error(String(error));
        emitMiddlewareError(bus, config, context, asError);
        if (!res.headersSent) {
          res.status(500).json(MIDDLEWARE_ERROR_BODY);
        } else if (!res.writableEnded) {
          res.end();
        }
      });
    });
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
 * Whether a configured route covers this method and path.
 *
 * Used only to detect a route key written with the mount prefix. It reuses the
 * same matcher `grant` uses, so "did the operator mean this route" is answered
 * the same way in both places.
 *
 * @param config - Resolved configuration
 * @param method - HTTP method of the request
 * @param path - Path including the mount prefix
 * @returns True when some configured route covers it
 */
function matchesConfiguredRoute(config: LensConfig, method: string, path: string): boolean {
  return config.routes.some(
    route =>
      (route.method === method || route.method === "*") &&
      (route.path === path || pathMatchesPattern(route.path, path)),
  );
}

/**
 * Merge our headers into whatever the response already has, so an app's own
 * CORS layer keeps working.
 *
 * `Access-Control-Allow-Origin` is replaced, never joined — a comma-joined ACAO
 * is a value browsers reject. `Vary` is a list and is unioned like the others, so
 * an app's existing `Accept-Encoding` survives.
 */
function applyCorsHeaders(res: Response, headers: Record<string, string>): void {
  const merged = mergeCorsHeaders(
    name => {
      const value = res.getHeader(name);
      return value === undefined ? undefined : String(value);
    },
    headers,
  );
  for (const [name, value] of Object.entries(merged)) res.setHeader(name, value);
}

export type { HTTPRequestContext };
export { PrometheusRegistry, prometheusHandler } from "@x402-lens/core";
