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
 */

import { randomUUID } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import {
  EventBus,
  callbackSink,
  consoleSink,
  diagnose,
  jsonlFileSink,
  loadConfig,
  makeEvent,
  resolveConfig,
  toRoutesConfig,
  type Finding,
  type LensConfig,
  type LensConfigInput,
  type LensEvent,
  type LensSink,
  type PaymentScheme,
  type RouteInput,
  type WirePaymentPayload,
  type WirePaymentRequired,
  type WireSettleResponse,
  type WireVerifyResponse,
} from "@x402-lens/core";
import {
  HTTPFacilitatorClient,
  x402HTTPResourceServer,
  x402ResourceServer,
  type FacilitatorClient,
  type HTTPRequestContext,
  type RoutesConfig,
} from "@x402/core/server";
import { paymentMiddlewareFromHTTPServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { UptoEvmScheme } from "@x402/evm/upto/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { UptoSvmScheme } from "@x402/svm/upto/server";
import { currentRequestContext, runWithRequestContext } from "./context.js";
import { observePaymentRequired } from "./observe.js";

/** Where the lens should send events. */
export interface LensSinkOptions {
  /** Print a compact line per event. Defaults to `true`. */
  console?: boolean;
  /** Append newline-delimited JSON to this path. */
  jsonlPath?: string;
  /** Called for every event. Exceptions are caught and never reach the caller. */
  onEvent?: (event: LensEvent) => void;
}

/** Short route form: a bare price, or the full per-route options. */
export type RouteMap = Record<string, string | Omit<RouteInput, "route">>;

export interface PaymentLensOptions extends Omit<LensConfigInput, "routes"> {
  /**
   * Route prices, in either the short map form
   * (`{ "GET /weather": "$0.001" }`) or the `RouteInput[]` form. Overrides the
   * config file and `X402_PRICE__*`.
   */
  routes?: RouteMap | RouteInput[];
  /** Pre-resolved config. Skips loading entirely, including validation. */
  config?: LensConfig;
  /** Where events go. Defaults to console. */
  sinks?: LensSinkOptions;
  /** Extra sinks, appended after the ones built from `sinks`. */
  extraSinks?: LensSink[];
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
   * free tier), or a reason string to deny with a 403. Every decision is
   * emitted as `access.granted` / `access.denied`, so a bypass is never silent.
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
  /** The route's own configuration, including its prices and metadata. */
  config: unknown;
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
  const config = options.config ?? resolveConfig({
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
  const config = options.config ?? await loadConfig({
    ...options,
    routes: normaliseRouteInput(options.routes),
  });
  return buildLens(config, options);
}

function normaliseRouteInput(routes: PaymentLensOptions["routes"]): RouteInput[] | undefined {
  if (!routes) return undefined;
  if (Array.isArray(routes)) return routes;
  // A bare string is the common case; an object allows per-route options such as
  // `paymentFlow` without dropping to the array form.
  return Object.entries(routes).map(([route, value]) =>
    typeof value === "string" ? { route, price: value } : { route, ...value },
  );
}

function buildLens(config: LensConfig, options: PaymentLensOptions): PaymentLens {
  const bus = new EventBus([
    ...buildSinks(options.sinks),
    ...(options.extraSinks ?? []),
  ]);
  const readableBody = options.readableBody ?? true;

  const facilitatorClient =
    options.facilitatorClient ?? buildFacilitatorClient(config);
  const server = new x402ResourceServer(facilitatorClient);
  const schemes = schemesInUse(config);
  for (const network of config.networks) registerScheme(server, network, schemes);

  const routes = options.routesConfig ?? (toRoutesConfig(config) as unknown as RoutesConfig);

  attachHooks(server, bus, config);

  const httpServer = new x402HTTPResourceServer(server, routes);
  const inner = paymentMiddlewareFromHTTPServer(httpServer);
  const corsHeaders = buildCorsHeaders(options.cors);

  if (options.grant) {
    const grant = options.grant;
    httpServer.onProtectedRequest(async (context, routeConfig) => {
      const method = safeCall(() => context.adapter.getMethod()) ?? "GET";
      const path = safeCall(() => context.adapter.getPath()) ?? context.path ?? "/";
      const decision = await grant({
        method,
        path,
        route: `${method} ${path}`,
        header: (name: string) => safeCall(() => context.adapter.getHeader(name)),
        query: safeCall(() => context.adapter.getQueryParams?.() ?? {}) ?? {},
        config: routeConfig,
      });

      if (decision === true) {
        bus.emit(
          makeEvent<LensEvent>({
            type: "access.granted",
            requestId: currentRequestContext()?.requestId ?? randomUUID(),
            route: `${method} ${path}`,
            scheme: "exact",
            network: config.network,
            amount: "0",
            asset: "",
            payTo: config.payTo,
          } as LensEvent),
        );
        return { grantAccess: true };
      }

      if (typeof decision === "string") {
        bus.emit(
          makeEvent<LensEvent>({
            type: "access.denied",
            requestId: currentRequestContext()?.requestId ?? randomUUID(),
            route: `${method} ${path}`,
            scheme: "exact",
            network: config.network,
            amount: "0",
            asset: "",
            payTo: config.payTo,
            reason: decision,
          } as LensEvent),
        );
        return { abort: true, reason: decision };
      }

      return undefined;
    });
  }

  const middleware: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    const context = {
      requestId: randomUUID(),
      startedAt: Date.now(),
      method: req.method,
      path: req.path,
    };

    if (corsHeaders) applyCorsHeaders(res, corsHeaders);

    const emitRequired = (paymentRequired: WirePaymentRequired): void => {
      const entries = paymentRequired.accepts ?? [];
      const entry = entries[0];
      bus.emit(
        makeEvent<LensEvent>({
          type: "payment.required",
          requestId: context.requestId,
          route: `${context.method} ${context.path}`,
          scheme: entry?.scheme ?? "exact",
          network: entry?.network ?? config.network,
          amount: entry?.amount ?? "0",
          asset: entry?.asset ?? "",
          payTo: entry?.payTo ?? config.payTo,
          offers: entries.length,
          durationMs: Date.now() - context.startedAt,
          findings: diagnose({ paymentRequired, now: context.startedAt }),
        } as LensEvent),
      );
    };

    observePaymentRequired(res, emitRequired, { mirrorBody: readableBody });

    runWithRequestContext(context, () => inner(req, res, next));
  };

  return {
    middleware,
    server,
    httpServer,
    config,
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
 * Call an adapter accessor, treating a throw as "not available".
 *
 * Adapters are third-party code; a missing or throwing accessor must not turn
 * an access decision into a 500.
 */
function safeCall<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/**
 * Build the SDK facilitator client, carrying auth headers and a request
 * timeout when configured.
 *
 * The SDK requires auth headers keyed by endpoint; passing a flat object throws
 * at request time, so the shape is validated once here rather than surfacing as
 * a failed payment later.
 */
function buildFacilitatorClient(config: LensConfig): HTTPFacilitatorClient {
  const authHeaders = config.facilitatorHeaders;
  const timeoutMs = config.facilitatorTimeoutMs;

  return new HTTPFacilitatorClient({
    url: config.facilitatorUrl,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(authHeaders ? { createAuthHeaders: async () => authHeaders } : {}),
  });
}

function buildSinks(sinkOptions: LensSinkOptions | undefined): LensSink[] {
  const sinks: LensSink[] = [];
  if (sinkOptions?.console ?? true) sinks.push(consoleSink());
  if (sinkOptions?.jsonlPath) sinks.push(jsonlFileSink(sinkOptions.jsonlPath));
  if (sinkOptions?.onEvent) sinks.push(callbackSink(sinkOptions.onEvent));
  return sinks;
}

/**
 * The three headers a browser buyer needs, and nothing else.
 *
 * A literal `*` does not cover any of them on a credentialed request, so they
 * have to be named. `Access-Control-Allow-Headers` also needs `Content-Type`
 * whenever the retry carries a JSON body, because that alone triggers a
 * preflight before the payment header is even considered.
 */
function buildCorsHeaders(
  cors: PaymentLensOptions["cors"],
): Record<string, string> | undefined {
  if (!cors) return undefined;
  const headers: Record<string, string> = {
    "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE",
    "Access-Control-Allow-Headers": "Content-Type, PAYMENT-SIGNATURE",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  };
  if (typeof cors === "object" && cors.origin) {
    headers["Access-Control-Allow-Origin"] = cors.origin;
    if (cors.origin !== "*") headers.Vary = "Origin";
  }
  return headers;
}

/**
 * Merge our headers into whatever the response already has, so an app's own
 * CORS layer keeps working.
 */
function applyCorsHeaders(res: Response, headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(headers)) {
    const existing = res.getHeader(name);
    if (existing === undefined) {
      res.setHeader(name, value);
      continue;
    }
    const merged = new Set(
      String(existing)
        .split(",")
        .map(part => part.trim())
        .filter(Boolean),
    );
    for (const item of value.split(",").map(part => part.trim())) merged.add(item);
    res.setHeader(name, Array.from(merged).join(", "));
  }
}

/**
 * Register the schemes this package supports on one network.
 *
 * `exact` is always registered; `upto` only when a route asks for it, so the
 * challenge for an all-`exact` deployment stays byte-identical to before.
 *
 * @param server - Resource server to register on
 * @param network - CAIP-2 network, already validated
 * @param schemes - Schemes any route on this network needs
 */
function registerScheme(
  server: x402ResourceServer,
  network: string,
  schemes: ReadonlySet<PaymentScheme>,
): void {
  const separator = network.indexOf(":");
  const namespace = separator === -1 ? network : network.slice(0, separator);
  // `Network` is a template-literal type; the value was validated as CAIP-2 by
  // `resolveConfig` before reaching here.
  const caip2 = network as `${string}:${string}`;

  switch (namespace) {
    case "eip155": {
      server.register(caip2, new ExactEvmScheme());
      if (schemes.has("upto")) server.register(caip2, new UptoEvmScheme());
      return;
    }
    case "solana": {
      server.register(caip2, new ExactSvmScheme());
      if (schemes.has("upto")) server.register(caip2, new UptoSvmScheme({}));
      return;
    }
    default:
      throw new Error(
        `[x402-lens] No scheme for namespace "${namespace}". This package registers exact (and upto) schemes for eip155 and solana. For any other network, keep the returned server instance and call server.register(network, scheme) yourself.`,
      );
  }
}

/** Which schemes the configured routes actually need. */
function schemesInUse(config: LensConfig): Set<PaymentScheme> {
  const used = new Set<PaymentScheme>();
  for (const route of config.routes) used.add(route.scheme ?? "exact");
  return used;
}

/** The three fields every event needs from a `PaymentRequirements`. */
interface RequirementsShape {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
}

function attachHooks(server: x402ResourceServer, bus: EventBus, config: LensConfig): void {
  server.onAfterVerify(async context => {
    const requirements = context.requirements as unknown as RequirementsShape;
    const result = context.result as unknown as WireVerifyResponse;
    const payload = context.paymentPayload as unknown as WirePaymentPayload;
    const base = baseEvent(requirements, config, result.isValid ? result.payer : undefined);
    const findings: Finding[] = diagnose({
      verifyResponse: result,
      paymentPayload: payload,
      paymentRequired: syntheticChallenge(requirements),
    });

    if (!result.isValid) {
      bus.emit(
        makeEvent<LensEvent>({
          ...base,
          type: "payment.failed",
          reason: result.invalidReason ?? "unknown",
          findings,
        } as LensEvent),
      );
      return;
    }

    bus.emit(makeEvent<LensEvent>({ ...base, type: "payment.verified" } as LensEvent));
  });

  server.onVerifyFailure(async context => {
    const requirements = context.requirements as unknown as RequirementsShape;
    bus.emit(
      makeEvent<LensEvent>({
        ...baseEvent(requirements, config),
        type: "facilitator.error",
        message: context.error.message,
      } as LensEvent),
    );
  });

  server.onAfterSettle(async context => {
    const requirements = context.requirements as unknown as RequirementsShape;
    const result = context.result as unknown as WireSettleResponse;
    bus.emit(
      makeEvent<LensEvent>({
        ...baseEvent(requirements, config, result.payer),
        type: "payment.settled",
        txHash: result.transaction ?? "",
        phase: context.phase,
        findings: diagnose({ settleResponse: result }),
      } as LensEvent),
    );
  });

  server.onSettleFailure(async context => {
    const requirements = context.requirements as unknown as RequirementsShape;
    const settle = settleFromError(context.error);
    bus.emit(
      makeEvent<LensEvent>({
        ...baseEvent(requirements, config, settle?.payer),
        type: "payment.settle_failed",
        reason: settle?.errorReason ?? context.error.message,
        ...(settle?.transaction ? { txHash: settle.transaction } : {}),
        phase: context.phase,
        findings: diagnose({ settleResponse: settle }),
      } as LensEvent),
    );
  });

  server.onVerifiedPaymentCanceled(async context => {
    const requirements = context.requirements as unknown as RequirementsShape;
    bus.emit(
      makeEvent<LensEvent>({
        ...baseEvent(requirements, config),
        type: "payment.canceled",
        cancelReason: context.reason,
        phase: context.phase,
      } as LensEvent),
    );
  });
}

function baseEvent(
  requirements: RequirementsShape,
  config: LensConfig,
  buyer?: string,
): Omit<LensEvent, "type"> {
  const context = currentRequestContext();
  return {
    ts: new Date().toISOString(),
    requestId: context?.requestId ?? randomUUID(),
    route: `${context?.method ?? "GET"} ${context?.path ?? "/"}`,
    scheme: requirements.scheme ?? "exact",
    network: requirements.network ?? config.network,
    amount: requirements.amount ?? "0",
    asset: requirements.asset ?? "",
    payTo: requirements.payTo ?? config.payTo,
    ...(buyer ? { buyer } : {}),
    ...(context ? { durationMs: Date.now() - context.startedAt } : {}),
  } as Omit<LensEvent, "type">;
}

/**
 * Hooks receive the matched requirement, not the whole challenge. Rebuilding a
 * one-entry challenge lets the same findings rules run on both paths.
 */
function syntheticChallenge(requirements: RequirementsShape): WirePaymentRequired {
  return {
    x402Version: 2,
    accepts: [requirements as unknown as NonNullable<WirePaymentRequired["accepts"]>[number]],
  };
}

/** Settlement failures arrive as a thrown error carrying the settle response. */
function settleFromError(error: unknown): WireSettleResponse | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as {
    settleResponse?: WireSettleResponse;
    result?: WireSettleResponse;
    body?: WireSettleResponse;
  };
  return candidate.settleResponse ?? candidate.result ?? candidate.body;
}

export type { HTTPRequestContext };