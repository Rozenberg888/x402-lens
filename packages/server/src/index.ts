/**
 * Server-side pieces shared by every x402-lens adapter.
 *
 * Express mutates a `res` object; Hono returns a `Response`. Those are
 * different enough that one middleware cannot serve both, but everything
 * underneath — building the resource server, registering schemes, attaching the
 * lifecycle hooks, and turning SDK callbacks into events — is identical.
 *
 * Keeping that half here means an adapter is a request/response shim, and a fix
 * to event shaping reaches every framework at once. Duplicating it per adapter
 * would have meant two copies of the same payment path quietly diverging.
 *
 * Nothing here imports a framework, and nothing here decides policy: the
 * adapter owns the request flow.
 */

import {
  HTTPFacilitatorClient,
  x402HTTPResourceServer,
  x402ResourceServer,
  type FacilitatorClient,
  type RoutesConfig,
} from "@x402/core/server";
import type { DeepReadonly, PaymentRequirements, SchemeNetworkServer } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { UptoEvmScheme } from "@x402/evm/upto/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { UptoSvmScheme } from "@x402/svm/upto/server";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  ConfigError,
  EventBus,
  PrometheusRegistry,
  callbackSink,
  consoleSink,
  diagnose,
  jsonlFileSink,
  makeEvent,
  openTelemetrySink,
  prometheusSink,
  sentryBreadcrumbSink,
  settleResponseFromError,
  toRoutesConfig,
  type Finding,
  type LensConfig,
  type LensEvent,
  type LensSink,
  type OtelTracerLike,
  type PaymentScheme,
  type RouteInput,
  type RouteMap,
  type RoutePrice,
  type SentryLike,
  type WirePaymentPayload,
  type WirePaymentRequired,
  type WireSettleResponse,
  type WireVerifyResponse,
} from "@x402-lens/core";

/** Buyer-facing body when the facilitator cannot be reached at init. */
export const FACILITATOR_UNAVAILABLE_BODY = {
  error: "facilitator_unavailable",
  code: "FACILITATOR_UNAVAILABLE",
} as const;

/** Buyer-facing body when a `grant` callback denies access (reason stays on the event). */
export const ACCESS_DENIED_BODY = { error: "access_denied" } as const;

/** Buyer-facing body for an unexpected failure inside the middleware itself. */
export const MIDDLEWARE_ERROR_BODY = {
  error: "internal_error",
  code: "MIDDLEWARE_ERROR",
} as const;

/** Where the lens sends events. Identical across adapters. */
export interface LensSinkOptions {
  /** Print a compact line per event. Defaults to `true`. */
  console?: boolean;
  /** Append newline-delimited JSON to this path. */
  jsonlPath?: string;
  /** Called for every event. Exceptions are caught and never reach the caller. */
  onEvent?: (event: LensEvent) => void;
  /** Record counters for Prometheus. `true` uses the shared registry. */
  prometheus?: boolean | PrometheusRegistry;
  /** OpenTelemetry tracer (`trace.getTracer("x402-lens")`). */
  otel?: OtelTracerLike;
  /** Sentry-compatible handle, recorded as breadcrumbs. */
  sentry?: SentryLike;
}

/** Options every adapter accepts, before framework-specific additions. */
export interface LensCommonOptions {
  /** Pre-resolved config. Skips file/env loading, but still validates. */
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
   * channel storage, an authorizer signer — so the built instance is passed
   * here instead.
   */
  extraSchemes?: CustomSchemeRegistration[];
  /** Override the `RoutesConfig` handed to the official middleware. */
  routesConfig?: RoutesConfig;
  /** Mirror the decoded challenge into the 402 JSON body. Defaults to true. */
  readableBody?: boolean;
  /** Emit the three headers a browser buyer needs. */
  cors?: boolean | { origin?: string };
  /** Replace the facilitator client entirely. */
  facilitatorClient?: FacilitatorClient;
}

/** Build the sink list an adapter was configured with. */
export function buildSinks(sinkOptions: LensSinkOptions | undefined): LensSink[] {
  const sinks: LensSink[] = [];
  if (sinkOptions?.console ?? true) sinks.push(consoleSink());
  if (sinkOptions?.jsonlPath) sinks.push(jsonlFileSink(sinkOptions.jsonlPath));
  if (sinkOptions?.onEvent) sinks.push(callbackSink(sinkOptions.onEvent));
  if (sinkOptions?.prometheus) {
    sinks.push(
      prometheusSink(sinkOptions.prometheus === true ? undefined : sinkOptions.prometheus),
    );
  }
  if (sinkOptions?.otel) sinks.push(openTelemetrySink(sinkOptions.otel));
  if (sinkOptions?.sentry) sinks.push(sentryBreadcrumbSink(sinkOptions.sentry));
  return sinks;
}

/**
 * Build the SDK facilitator client, carrying auth headers and a timeout.
 *
 * Auth headers must be keyed by facilitator path (`verify` / `settle` /
 * `supported`). `resolveConfig` rejects flat objects before this runs, so a
 * misconfigured client never reaches the first payment request as HTTP 500.
 */
export function buildFacilitatorClient(config: LensConfig): HTTPFacilitatorClient {
  const authHeaders = config.facilitatorHeaders;
  const timeoutMs = config.facilitatorTimeoutMs;
  return new HTTPFacilitatorClient({
    url: config.facilitatorUrl,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(authHeaders ? { createAuthHeaders: async () => authHeaders } : {}),
  });
}

/**
 * The three headers a browser buyer needs, and nothing else.
 *
 * A literal `*` does not cover any of them on a credentialed request, so they
 * have to be named. `Access-Control-Allow-Headers` also needs `Content-Type`
 * whenever the retry carries a JSON body, because that alone triggers a
 * preflight before the payment header is even considered.
 */
export function buildCorsHeaders(
  cors: boolean | { origin?: string } | undefined,
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
 * Merge our CORS headers into whatever the response already carries, so an
 * app's own CORS layer keeps working.
 *
 * List headers are unioned. Singleton CORS headers replace — comma-joining
 * `Access-Control-Allow-Origin` produces a value browsers reject.
 *
 * @param existing - Reads the current value of a header, if any
 * @param headers - Headers the lens wants to set
 * @returns The headers to write, already merged
 */
export function mergeCorsHeaders(
  existing: (name: string) => string | undefined,
  headers: Record<string, string>,
): Record<string, string> {
  const replace = new Set(["access-control-allow-origin", "vary"]);
  const merged: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const current = existing(name);
    if (current === undefined || replace.has(name.toLowerCase())) {
      merged[name] = value;
      continue;
    }
    const items = new Set(
      current
        .split(",")
        .map(part => part.trim())
        .filter(Boolean),
    );
    for (const item of value.split(",").map(part => part.trim())) items.add(item);
    merged[name] = Array.from(items).join(", ");
  }
  return merged;
}

/**
 * Strip trailing slashes from a pre-built config's facilitator URL.
 *
 * `resolveConfig` already does this for configuration it built itself. A caller
 * who assembles `LensConfig` by hand bypasses that, and the URL then differs
 * from what the rest of the package assumes — `GET //supported` on a
 * double-slashed URL is not the same request as `GET /supported`.
 *
 * @param config - Resolved configuration, possibly hand-built
 * @returns The same configuration with a normalised URL
 */
export function normalisePassedConfig(config: LensConfig): LensConfig {
  return { ...config, facilitatorUrl: config.facilitatorUrl.replace(/\/+$/, "") };
}

/**
 * Accept the short route map form and produce the array the SDK wants.
 *
 * `{ "GET /weather": "$0.001" }` is what people write; `RouteInput[]` is what
 * `resolveConfig` consumes. Both adapters offered the short form, so both had a
 * copy of this conversion.
 *
 * @param routes - Short map or array form, or undefined
 * @returns Normalised array, or undefined when no routes were given
 * @throws {ConfigError} When an entry is neither a price string nor an options object
 */
export function normaliseRouteInput(
  routes: RouteMap | RouteInput[] | undefined,
): RouteInput[] | undefined {
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

/**
 * Decode a request path, falling back to the raw value.
 *
 * `decodeURIComponent` throws on a malformed escape such as `%ZZ`. A client can
 * send that; the lens must not answer 500 because of it, so the raw path is used
 * and the route lookup simply fails to match.
 *
 * @param path - Raw request path
 * @returns Decoded path, or the input when it cannot be decoded
 */
export function decodedRoutePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * The challenge fields a client needs without base64-decoding the header.
 *
 * Shared by both HTTP adapters: the 402 body is server-defined in v2, so
 * mirroring the challenge there is what makes `curl | jq` usable.
 *
 * @param paymentRequired - Decoded challenge
 * @returns The subset to merge into a JSON body
 */
export function bodyFieldsFromChallenge(
  paymentRequired: WirePaymentRequired,
): Record<string, unknown> {
  return {
    x402Version: paymentRequired.x402Version,
    ...(paymentRequired.error ? { error: paymentRequired.error } : {}),
    ...(paymentRequired.resource ? { resource: paymentRequired.resource } : {}),
    ...(paymentRequired.accepts ? { accepts: paymentRequired.accepts } : {}),
  };
}

/**
 * A scheme the caller registers themselves.
 *
 * For a scheme this package does not ship — `batch-settlement`, `auth-capture`,
 * or anything newer — configuration cannot describe it: those schemes need
 * runtime objects (channel storage, an authorizer signer) that an environment
 * variable cannot express. So the caller passes the built scheme itself rather
 * than a name.
 */
export interface CustomSchemeRegistration {
  /** CAIP-2 network the scheme applies to. */
  network: string;
  /** Scheme identifier, e.g. `"batch-settlement"`. */
  scheme: string;
  /** The SDK scheme instance, from `@x402/evm` or `@x402/svm`. */
  implementation: SchemeNetworkServer;
}

/**
 * Register the schemes this package supports on one network.
 *
 * `exact` is always registered; the others only when a route asks for them, so
 * the challenge for an all-`exact` deployment stays byte-identical.
 *
 * @param server - Resource server to register on
 * @param network - CAIP-2 network, already validated
 * @param schemes - Schemes any route on this network needs
 */
export function registerScheme(
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
        `[x402-lens] No scheme for namespace "${namespace}". This package ships exact (and upto) for eip155 and solana. For any other network, or for batch-settlement / auth-capture, pass the built scheme as extraSchemes: [{ network: "${network}", scheme: "…", implementation }].`,
      );
  }
}

/** Which schemes the configured routes actually need. */
export function schemesInUse(config: LensConfig): Set<PaymentScheme> {
  const used = new Set<PaymentScheme>();
  for (const route of config.routes) used.add(route.scheme ?? "exact");
  return used;
}

/**
 * Per-request context carried through the async call chain.
 *
 * The official middleware builds its own transport context, so hooks only
 * receive a path and method — not the request id or the start time. An
 * AsyncLocalStorage store gives hooks the full picture without reaching into
 * private SDK fields, and without keying state on a route that may have many
 * concurrent requests.
 */
export interface RequestContext {
  requestId: string;
  startedAt: number;
  method: string;
  path: string;
}

const requestStorage = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with `context` bound to the current async chain. */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return requestStorage.run(context, fn);
}

/** The context for the request currently being handled, if any. */
export function currentRequestContext(): RequestContext | undefined {
  return requestStorage.getStore();
}

/**
 * The fields every lens event needs from the SDK's `PaymentRequirements`.
 *
 * Narrower than `PaymentRequirements` on purpose — an event needs five fields,
 * not the whole requirement — but taken from the SDK's own type rather than
 * restated, so a renamed or re-typed field here is a compile error instead of a
 * silent `undefined` at runtime.
 *
 * `amount` and `payTo` are read through `??` below even though the SDK types
 * them as required. That is deliberate defence for a diagnostic tool: an event
 * is emitted on the failure path, which is exactly where a third-party SDK is
 * most likely to hand over a partially-built requirement. The cost is two
 * fallbacks; the alternative is throwing while diagnosing a throw.
 */
type RequirementsShape = DeepReadonly<
  Pick<PaymentRequirements, "scheme" | "network" | "asset">
> & {
  readonly amount?: string;
  readonly payTo?: string;
};

/**
 * The event fields the SDK's requirements type can supply.
 *
 * Exported because a caller writing their own hooks needs the same mapping, and
 * because a test asserting on `baseEvent` should not restate the shape.
 */
export type LensEventRequirements = RequirementsShape;

/**
 * Turn SDK lifecycle callbacks into lens events.
 *
 * @param server - Resource server the adapter built
 * @param bus - Bus that receives the events
 * @param config - Resolved configuration, for defaults
 */
export function attachHooks(server: x402ResourceServer, bus: EventBus, config: LensConfig): void {
  server.onAfterVerify(async context => {
    const requirements = context.requirements;
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
    const requirements = context.requirements;
    bus.emit(
      makeEvent<LensEvent>({
        ...baseEvent(requirements, config),
        type: "facilitator.error",
        message: context.error.message,
      } as LensEvent),
    );
  });

  server.onAfterSettle(async context => {
    const requirements = context.requirements;
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
    const requirements = context.requirements;
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
    const requirements = context.requirements;
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

/** Shared event fields, read from the ALS context when one is bound. */
export function baseEvent(
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
export function syntheticChallenge(requirements: RequirementsShape): WirePaymentRequired {
  return {
    x402Version: 2,
    accepts: [requirements as unknown as NonNullable<WirePaymentRequired["accepts"]>[number]],
  };
}

/**
 * Find the configured route that covers this method/path for grant callbacks.
 * Exact matches win; then `:param` / `*` segments; then method `*`.
 */
export function matchRouteConfig(
  config: LensConfig,
  method: string,
  path: string,
): RoutePrice | undefined {
  const candidates = config.routes.filter(route => route.method === method || route.method === "*");
  const exact = candidates.find(route => route.path === path);
  if (exact) return exact;
  return candidates.find(route => pathMatchesPattern(route.path, path));
}

/** Match `/users/:id` and `/files/*` style patterns against a request path. */
export function pathMatchesPattern(pattern: string, path: string): boolean {
  if (pattern === path) return true;
  const patternParts = pattern.split("/");
  const pathParts = path.split("/");
  if (patternParts.length !== pathParts.length) return false;
  for (let index = 0; index < patternParts.length; index += 1) {
    const expected = patternParts[index] ?? "";
    const actual = pathParts[index] ?? "";
    if (expected.startsWith(":") || expected === "*") continue;
    if (expected !== actual) return false;
  }
  return true;
}

/**
 * Call an adapter accessor, treating a throw as "not available".
 *
 * Adapters are third-party code; a missing or throwing accessor must not turn
 * an access decision into a 500.
 */
export function safeCall<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/**
 * Longest reason that may reach an event.
 *
 * A grant callback returns a human string or throws with a message. Both go
 * into the event, and both can be arbitrarily long — a thrown database error
 * with a full query is the realistic case. Truncating here rather than at each
 * call site is the point: the previous version truncated only the thrown path,
 * so `grant: () => veryLongString` put the full text in the log.
 */
export const MAX_REASON_LENGTH = 200;

/**
 * Emit `access.granted` / `access.denied`.
 *
 * @param bus - Event bus for this lens
 * @param config - Resolved config, for the default network and payTo
 * @param context - Request that made the decision
 * @param type - Which event to emit
 * @param reason - Why access was denied; truncated to {@link MAX_REASON_LENGTH}
 */
export function emitAccess(
  bus: EventBus,
  config: LensConfig,
  context: RequestContext,
  type: "access.granted" | "access.denied",
  reason?: string,
): void {
  bus.emit(
    makeEvent<LensEvent>({
      type,
      requestId: context.requestId,
      route: `${context.method} ${context.path}`,
      scheme: "exact",
      network: config.network,
      amount: "0",
      asset: "",
      payTo: config.payTo,
      durationMs: Date.now() - context.startedAt,
      ...(reason ? { reason: reason.slice(0, MAX_REASON_LENGTH) } : {}),
    } as LensEvent),
  );
}

/**
 * Emit `facilitator.error` for a failure inside the middleware itself.
 *
 * @param bus - Event bus for this lens
 * @param config - Resolved config
 * @param context - Request being handled
 * @param error - The failure; its message goes on the event, never the body
 */
export function emitMiddlewareError(
  bus: EventBus,
  config: LensConfig,
  context: RequestContext,
  error: Error,
): void {
  bus.emit(
    makeEvent<LensEvent>({
      type: "facilitator.error",
      ts: new Date().toISOString(),
      requestId: context.requestId,
      route: `${context.method} ${context.path}`,
      scheme: "exact",
      network: config.network,
      amount: "0",
      asset: "",
      payTo: config.payTo,
      message: `middleware: ${error.message}`,
    } as LensEvent),
  );
}

/** The challenge shape an observer hands back, as far as events care. */
export interface ChallengeShape {
  accepts?: Array<{
    scheme?: string;
    network?: string;
    amount?: string;
    asset?: string;
    payTo?: string;
  }>;
}

/**
 * Emit `payment.required` for a challenge that went out.
 *
 * @param bus - Event bus for this lens
 * @param config - Resolved config
 * @param context - Request that received the challenge
 * @param paymentRequired - Decoded challenge, for the first offer and findings
 */
export function emitRequired(
  bus: EventBus,
  config: LensConfig,
  context: RequestContext,
  paymentRequired: ChallengeShape,
): void {
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
      findings: diagnose({ paymentRequired: paymentRequired as never, now: context.startedAt }),
    } as LensEvent),
  );
}

/** The servers and readiness signal one configuration produces. */
export interface LensServers {
  bus: EventBus;
  server: x402ResourceServer;
  httpServer: x402HTTPResourceServer;
  ready: Promise<void>;
  /** Emit the `facilitator.error` event for an init failure, once. */
  emitInitFailure(error: Error): void;
  /** The error that failed init, if it has failed. */
  initFailure(): Error | undefined;
}

/**
 * Build the resource server and its HTTP wrapper for one configuration.
 *
 * The `ready` promise is owned here rather than by the adapter so every
 * framework observes the same initialisation: one `/supported` probe, one
 * failure event, one rejection to await.
 *
 * @param config - Validated configuration
 * @param options - Sinks, facilitator override, and routes override
 * @returns The servers, the event bus, and the readiness promise
 */
export function buildServers(config: LensConfig, options: LensCommonOptions): LensServers {
  const bus = new EventBus([...buildSinks(options.sinks), ...(options.extraSinks ?? [])]);
  const facilitatorClient = options.facilitatorClient ?? buildFacilitatorClient(config);

  const server = new x402ResourceServer(facilitatorClient);
  const schemes = schemesInUse(config);

  // Custom schemes first. A caller supplying their own implementation for a
  // network this package does not ship — `xrpl:1` with a custom scheme, or
  // `batch-settlement` anywhere — must not hit the namespace throw below.
  const customNetworks = new Set<string>();
  for (const custom of options.extraSchemes ?? []) {
    server.register(custom.network as `${string}:${string}`, custom.implementation);
    customNetworks.add(custom.network);
  }

  for (const network of config.networks) {
    // Skip only networks the caller fully covered. If they registered one
    // scheme for a network, the built-in `exact` is still worth adding: the
    // common case should not require a registration list.
    const suppliedExact = options.extraSchemes?.some(
      custom => custom.network === network && custom.scheme === "exact",
    );
    if (customNetworks.has(network) && suppliedExact) continue;
    registerScheme(server, network, schemes);
  }

  const routes = options.routesConfig ?? (toRoutesConfig(config) as unknown as RoutesConfig);
  attachHooks(server, bus, config);

  const httpServer = new x402HTTPResourceServer(server, routes);
  let failure: Error | undefined;
  let emitted = false;

  const emitInitFailure = (error: Error): void => {
    if (emitted) return;
    emitted = true;
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
      failure = asError;
      emitInitFailure(asError);
      throw asError;
    },
  );
  // Keep `ready` rejectable for awaiters, but do not crash the process when
  // nobody has attached yet (apps may mount middleware before awaiting ready).
  void ready.catch(() => {});

  return {
    bus,
    server,
    httpServer,
    ready,
    emitInitFailure,
    initFailure: () => failure,
  };
}

