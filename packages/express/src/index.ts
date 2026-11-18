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
  PrometheusRegistry,
  callbackSink,
  consoleSink,
  diagnose,
  jsonlFileSink,
  loadConfig,
  makeEvent,
  openTelemetrySink,
  prometheusSink,
  resolveConfig,
  sentryBreadcrumbSink,
  assertLensConfig,
  ConfigError,
  settleResponseFromError,
  toRoutesConfig,
  type Finding,
  type LensConfig,
  type LensConfigInput,
  type LensEvent,
  type LensSink,
  type OtelTracerLike,
  type PaymentScheme,
  type RouteInput,
  type RoutePrice,
  type SentryLike,
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
import { ExpressAdapter, paymentMiddlewareFromHTTPServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { UptoEvmScheme } from "@x402/evm/upto/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { UptoSvmScheme } from "@x402/svm/upto/server";
import { currentRequestContext, runWithRequestContext } from "./context.js";
import { observePaymentRequired } from "./observe.js";

/**
 * Buyer-facing body when the facilitator cannot be reached at init (or the
 * inner middleware rejects for the same reason). Full SDK detail stays on the
 * `facilitator.error` event — never in this JSON.
 */
const FACILITATOR_UNAVAILABLE_BODY = {
  error: "facilitator_unavailable",
  code: "FACILITATOR_UNAVAILABLE",
} as const;

/** Where the lens should send events. */
export interface LensSinkOptions {
  /** Print a compact line per event. Defaults to `true`. */
  console?: boolean;
  /** Append newline-delimited JSON to this path. */
  jsonlPath?: string;
  /** Called for every event. Exceptions are caught and never reach the caller. */
  onEvent?: (event: LensEvent) => void;
  /**
   * Record counters for Prometheus. Pass `true` for the shared registry, or a
   * `PrometheusRegistry` you will serve from `/metrics` via `prometheusHandler`.
   */
  prometheus?: boolean | PrometheusRegistry;
  /**
   * OpenTelemetry tracer (`trace.getTracer("x402-lens")`). Opens a short span
   * per event. `@opentelemetry/api` is not a dependency of this package.
   */
  otel?: OtelTracerLike;
  /**
   * Sentry-compatible handle (`import * as Sentry from "@sentry/node"`).
   * Records each event as a breadcrumb. Sentry is not a dependency.
   */
  sentry?: SentryLike;
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
    ? (assertLensConfig(options.config), options.config)
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
    ? (assertLensConfig(options.config), options.config)
    : await loadConfig({
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

function decodedRoutePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
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
  let initFailure: Error | undefined;
  let initFailureEmitted = false;

  const emitInitFailure = (error: Error): void => {
    if (initFailureEmitted) return;
    initFailureEmitted = true;
    bus.emit(
      makeEvent<LensEvent>({
        type: "facilitator.error",
        ts: new Date().toISOString(),
        requestId: randomUUID(),
        route: "INIT /supported",
        scheme: "exact",
        network: config.network,
        amount: "0",
        asset: "",
        payTo: config.payTo,
        message: error.message,
      } as LensEvent),
    );
  };

  // Own the facilitator probe so a failure is observable (`ready` + events)
  // instead of an opaque HTTP 500 from the SDK's lazy init path.
  const ready = httpServer.initialize().then(
    () => undefined,
    error => {
      const asError = error instanceof Error ? error : new Error(String(error));
      initFailure = asError;
      emitInitFailure(asError);
      throw asError;
    },
  );
  // Keep `ready` rejectable for awaiters, but do not crash the process when
  // nobody has attached yet (apps may mount middleware before awaiting ready).
  void ready.catch(() => {});

  // Disable the SDK's parallel syncFacilitatorOnStart probe — `ready` above is
  // the single source of truth for initialization.
  const inner = paymentMiddlewareFromHTTPServer(
    httpServer,
    undefined,
    undefined,
    false,
  );
  const corsHeaders = buildCorsHeaders(options.cors);
  if (options.cors === true) {
    // #region agent note — surface at build time without throwing
    process.emitWarning(
      "[x402-lens] cors: true does not set Access-Control-Allow-Origin. Pass cors: { origin: \"…\" } for browser buyers.",
      "X402LensCors",
    );
    // #endregion
  }

  const grant = options.grant;

  const respondFacilitatorUnavailable = (res: Response, requestId: string, route: string, error: Error): void => {
    bus.emit(
      makeEvent<LensEvent>({
        type: "facilitator.error",
        ts: new Date().toISOString(),
        requestId,
        route,
        scheme: "exact",
        network: config.network,
        amount: "0",
        asset: "",
        payTo: config.payTo,
        message: error.message,
      } as LensEvent),
    );
    if (!res.headersSent) {
      res.status(502).json(FACILITATOR_UNAVAILABLE_BODY);
    } else if (!res.writableEnded) {
      res.end();
    }
  };

  const middleware: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    const context = {
      requestId: randomUUID(),
      startedAt: Date.now(),
      method: req.method,
      path: req.path,
    };

    if (corsHeaders) applyCorsHeaders(res, corsHeaders);

    // Browser preflight must never hit the payment path (wildcard routes included).
    if (req.method === "OPTIONS") {
      next();
      return;
    }

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
          next();
          return;
        }

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
              bus.emit(
                makeEvent<LensEvent>({
                  type: "access.granted",
                  requestId: context.requestId,
                  route: `${context.method} ${context.path}`,
                  scheme: "exact",
                  network: config.network,
                  amount: "0",
                  asset: "",
                  payTo: config.payTo,
                } as LensEvent),
              );
              next();
              return;
            }

            if (typeof decision === "string") {
              bus.emit(
                makeEvent<LensEvent>({
                  type: "access.denied",
                  requestId: context.requestId,
                  route: `${context.method} ${context.path}`,
                  scheme: "exact",
                  network: config.network,
                  amount: "0",
                  asset: "",
                  payTo: config.payTo,
                  reason: decision,
                } as LensEvent),
              );
              if (!res.headersSent) res.status(403).json({ error: "access_denied" });
              return;
            }
          } catch (error) {
            const reason =
              error instanceof Error ? error.message.slice(0, 200) : "grant_error";
            bus.emit(
              makeEvent<LensEvent>({
                type: "access.denied",
                requestId: context.requestId,
                route: `${context.method} ${context.path}`,
                scheme: "exact",
                network: config.network,
                amount: "0",
                asset: "",
                payTo: config.payTo,
                reason,
              } as LensEvent),
            );
            if (!res.headersSent) {
              res.status(403).json({ error: "access_denied" });
            }
            return;
          }
        }

        try {
          await ready;
        } catch (error) {
          const asError =
            initFailure ??
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
          respondFacilitatorUnavailable(
            res,
            context.requestId,
            `${context.method} ${context.path}`,
            asError,
          );
        });
      })().catch((error: unknown) => {
        const asError = error instanceof Error ? error : new Error(String(error));
        respondFacilitatorUnavailable(
          res,
          context.requestId,
          `${context.method} ${context.path}`,
          asError,
        );
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
 * Find the configured route that covers this method/path for grant callbacks.
 * Exact matches win over method wildcards; parameterized paths need an exact
 * config key to be visible (same limitation as a flat route map).
 */
function matchRouteConfig(
  config: LensConfig,
  method: string,
  path: string,
): RoutePrice | undefined {
  const exact = config.routes.find(
    route => route.method === method && route.path === path,
  );
  if (exact) return exact;
  return config.routes.find(route => route.method === "*" && route.path === path);
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
 * Auth headers must be keyed by facilitator path (`verify` / `settle` /
 * `supported`). Flat objects are rejected by `resolveConfig` before this runs,
 * so a misconfigured client never reaches the first payment request as HTTP 500.
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
  if (sinkOptions?.prometheus) {
    sinks.push(
      prometheusSink(
        sinkOptions.prometheus === true
          ? undefined
          : sinkOptions.prometheus,
      ),
    );
  }
  if (sinkOptions?.otel) sinks.push(openTelemetrySink(sinkOptions.otel));
  if (sinkOptions?.sentry) sinks.push(sentryBreadcrumbSink(sinkOptions.sentry));
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
    const settle = settleResponseFromError(context.error);
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

export type { HTTPRequestContext };
export {
  PrometheusRegistry,
  prometheusHandler,
} from "@x402-lens/core";