/**
 * `paidTool()` — x402 v2 payments for MCP tools, with observability that
 * explains itself.
 *
 * MCP is not HTTP. A paid tool does not answer 402: it returns a result whose
 * content carries `PaymentRequired`, and the client retries with a payload in
 * `_meta`. That difference is why this adapter cannot reuse the Express or Hono
 * request flow — but the event shape, the findings engine and the sinks are the
 * same, so those come from `@x402-lens/core`.
 *
 * The audience differs too, and it changes what the output is for. An agent
 * calling a paid tool has no operator watching a log; the diagnosis has to be
 * legible to the model deciding whether to retry.
 *
 * What this does not do: reimplement verification or settlement. The SDK's
 * `createPaymentWrapper` owns the handshake, exactly as `@x402/express` owns it
 * for the HTTP adapters. A second implementation of a payment protocol is a
 * second place for it to be wrong.
 */

import { randomUUID } from "node:crypto";
import {
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
  type Finding,
  type LensEvent,
  type LensSink,
  type OtelTracerLike,
  type SentryLike,
  type WirePaymentRequirements,
  type WireSettleResponse,
} from "@x402-lens/core";
import {
  createPaymentWrapper,
  extractPaymentRequiredFromError,
  extractPaymentResponseFromMeta,
  type MCPToolCallback,
  type PaymentWrappedHandler,
  type ToolResult,
  type WrappedToolResult,
} from "@x402/mcp";
import type { x402ResourceServer } from "@x402/core/server";

/** Where the lens sends events. Same options as the HTTP adapters. */
export interface McpLensSinkOptions {
  /** Print a compact line per event. Defaults to `true`. */
  console?: boolean;
  /** Append newline-delimited JSON to this path. */
  jsonlPath?: string;
  /** Called for every event. Exceptions are caught and never reach the caller. */
  onEvent?: (event: LensEvent) => void;
  /** Record counters for Prometheus. */
  prometheus?: boolean | PrometheusRegistry;
  /** OpenTelemetry tracer. */
  otel?: OtelTracerLike;
  /** Sentry-compatible handle. */
  sentry?: SentryLike;
}

/** Configuration shared by every tool in one lens. */
export interface McpLensOptions {
  /** Where events go. Defaults to console. */
  sinks?: McpLensSinkOptions;
  /** Extra sinks, appended after the ones built from `sinks`. */
  extraSinks?: LensSink[];
}

/** Per-tool configuration. */
export interface PaidToolOptions {
  /**
   * The resource server the tool's schemes are registered on.
   *
   * Required: `createPaymentWrapper` validates that a scheme implementation
   * exists for every accepted network and throws if not, which is a deployment
   * error worth raising at startup rather than at the first paid call.
   */
  server: x402ResourceServer;
  /** Tool name, as registered with the MCP server. */
  toolName: string;
  /**
   * Payment requirements, one entry per accepted network.
   *
   * Build them with `resourceServer.buildPaymentRequirements({...})` so asset
   * and amount resolution stays in the SDK, or pass them directly for a fixed
   * price.
   */
  accepts: WirePaymentRequirements[];
  /**
   * Resource metadata attached to the challenge, so an agent can tell what it
   * is buying before it decides to pay.
   */
  resource?: {
    url?: string;
    description?: string;
    mimeType?: string;
  };
}

/** Handles for one instrumented tool. */
export interface PaidTool {
  /**
   * Wrap a tool's real handler.
   *
   * Return value goes straight to `mcpServer.tool(...)`. The inner handler runs
   * only after the SDK has verified payment.
   */
  wrap<TArgs extends Record<string, unknown>>(
    handler: PaymentWrappedHandler<TArgs>,
  ): MCPToolCallback<TArgs>;
}

/** The lens: one event bus for every tool it wraps. */
export interface McpLens {
  /** Define a paid tool. Throws immediately on an unusable configuration. */
  paidTool(options: PaidToolOptions): PaidTool;
  /** Subscribe to events from every tool. Returns an unsubscribe function. */
  on(listener: (event: LensEvent) => void): () => void;
  /** Flush sinks and stop emitting. */
  close(): Promise<void>;
}

function buildSinks(sinkOptions: McpLensSinkOptions | undefined): LensSink[] {
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
 * Create a lens for MCP tools.
 *
 * One bus per lens rather than per tool, so a server with five paid tools has
 * one event stream and one `close()`.
 *
 * @param options - Sinks for every tool this lens wraps
 * @returns The lens, with `paidTool()` to define tools
 *
 * @example
 * ```ts
 * const lens = mcpLens({ sinks: { console: false, onEvent: track } });
 *
 * const search = lens.paidTool({
 *   server: resourceServer,
 *   toolName: "search",
 *   accepts: await resourceServer.buildPaymentRequirements({
 *     scheme: "exact",
 *     network: "eip155:84532",
 *     payTo: "0x…",
 *     price: "$0.01",
 *   }),
 * });
 *
 * mcpServer.tool("search", "Premium search", { query: z.string() },
 *   search.wrap(async ({ query }) => ({
 *     content: [{ type: "text", text: await runSearch(query) }],
 *   })),
 * );
 * ```
 */
export function mcpLens(options: McpLensOptions = {}): McpLens {
  const bus = new EventBus([...buildSinks(options.sinks), ...(options.extraSinks ?? [])]);

  return {
    paidTool(toolOptions) {
      return definePaidTool(bus, toolOptions);
    },
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

function definePaidTool(bus: EventBus, options: PaidToolOptions): PaidTool {
  if (options.accepts.length === 0) {
    // An empty accepts array means the tool is silently free. That is the exact
    // failure a payment wrapper exists to prevent, so it is refused here rather
    // than discovered by an invoice that never arrives.
    throw new Error(
      `[x402-lens] paidTool("${options.toolName}") was given no accepts entries. An empty array means no payment is ever requested — build requirements with resourceServer.buildPaymentRequirements(), or leave the tool unwrapped.`,
    );
  }

  const first = options.accepts[0] as WirePaymentRequirements;
  const resourceUrl = options.resource?.url ?? `mcp://tool/${options.toolName}`;

  /** Fields every event for this tool carries. */
  const baseEvent = (requestId: string, durationMs?: number): Omit<LensEvent, "type"> =>
    ({
      ts: new Date().toISOString(),
      requestId,
      route: `TOOL ${options.toolName}`,
      scheme: first.scheme,
      network: first.network,
      amount: first.amount ?? "0",
      asset: first.asset ?? "",
      payTo: first.payTo ?? "",
      offers: options.accepts.length,
      ...(durationMs !== undefined ? { durationMs } : {}),
    }) as Omit<LensEvent, "type">;

  /**
   * The wrapper the SDK builds for these requirements.
   *
   * Created once per tool, not per call: `createPaymentWrapper` validates that
   * a scheme is registered for every requirement and throws if not, which is a
   * deployment error worth raising at startup.
   */
  const wrapper = createPaymentWrapper(options.server, {
    // `WirePaymentRequirements` is this package's own wire model; the SDK types
    // its network as a template literal. They describe the same object, and
    // `resolveConfig` already validated the CAIP-2 shape before a caller can
    // reach here.
    accepts: options.accepts as unknown as Parameters<typeof createPaymentWrapper>[1]["accepts"],
    resource: { url: resourceUrl, ...(options.resource ?? {}) },
  });

  return {
    wrap<TArgs extends Record<string, unknown>>(
      handler: PaymentWrappedHandler<TArgs>,
    ): MCPToolCallback<TArgs> {
      const wrapped = wrapper(handler) as MCPToolCallback<TArgs>;

      return async (args, extra) => {
        const requestId = randomUUID();
        const startedAt = Date.now();

        let result: WrappedToolResult;
        try {
          result = await wrapped(args, extra);
        } catch (error) {
          emitFailure(bus, baseEvent, requestId, error, options, startedAt);
          throw error;
        }

        emitOutcome(bus, baseEvent, requestId, options, result, startedAt);
        return result;
      };
    },
  };
}

/** A thrown tool call: the payment path failed before producing a result. */
function emitFailure(
  bus: EventBus,
  baseEvent: (requestId: string, durationMs?: number) => Omit<LensEvent, "type">,
  requestId: string,
  error: unknown,
  options: PaidToolOptions,
  startedAt: number,
): void {
  const asError = error instanceof Error ? error : new Error(String(error));

  // A 402 raised as a JSON-RPC error still carries the challenge; diagnosing it
  // is the difference between "it failed" and "here is which network was wrong".
  const paymentRequired =
    safeExtract(() => extractPaymentRequiredFromError(error)) ?? undefined;

  const findings: Finding[] = paymentRequired
    ? diagnose({ paymentRequired: paymentRequired as never, now: startedAt })
    : [];

  bus.emit(
    makeEvent<LensEvent>({
      ...baseEvent(requestId, Date.now() - startedAt),
      type: "payment.failed",
      reason: asError.message.slice(0, 200),
      findings,
    } as LensEvent),
  );
}

/** A completed tool call, settled or challenged. */
function emitOutcome(
  bus: EventBus,
  baseEvent: (requestId: string, durationMs?: number) => Omit<LensEvent, "type">,
  requestId: string,
  options: PaidToolOptions,
  result: WrappedToolResult,
  startedAt: number,
): void {
  const durationMs = Date.now() - startedAt;
  const settle = safeExtract(() => extractPaymentResponseFromMeta(result));

  if (settle) {
    emitSettle(bus, baseEvent, requestId, options, settle, durationMs);
    return;
  }

  const challenge = challengeIn(result);
  if (challenge) {
    bus.emit(
      makeEvent<LensEvent>({
        ...baseEvent(requestId, durationMs),
        type: "payment.required",
        findings: diagnose({ paymentRequired: challenge as never, now: startedAt }),
      } as LensEvent),
    );    return;
  }

  // A tool that ran without a payment and without a challenge: either it is
  // free (a wiring mistake worth seeing) or the SDK settled without attaching
  // the response. Either way the event records the call.
  bus.emit(
    makeEvent<LensEvent>({
      ...baseEvent(requestId, durationMs),
      type: "payment.settled",
      txHash: "",
    } as LensEvent),
  );
}

/** Emit the settlement event, splitting success from a reported failure. */
function emitSettle(
  bus: EventBus,
  baseEvent: (requestId: string, durationMs?: number) => Omit<LensEvent, "type">,
  requestId: string,
  options: PaidToolOptions,
  settle: WireSettleResponse,
  durationMs: number,
): void {
  const findings = diagnose({ settleResponse: settle });

  if (settle.success === false) {
    bus.emit(
      makeEvent<LensEvent>({
        ...baseEvent(requestId, durationMs),
        type: "payment.settle_failed",
        reason: settle.errorReason ?? "settle_failed",
        ...(settle.transaction ? { txHash: settle.transaction } : {}),
        ...(settle.payer ? { buyer: settle.payer } : {}),
        findings,
      } as LensEvent),
    );
    return;
  }

  bus.emit(
    makeEvent<LensEvent>({
      ...baseEvent(requestId, durationMs),
      type: "payment.settled",
      txHash: settle.transaction ?? "",
      ...(settle.payer ? { buyer: settle.payer } : {}),
      findings,
    } as LensEvent),
  );
  void options;
}

/**
 * Read the payment challenge out of a tool result.
 *
 * Per the MCP transport spec the challenge is either `structuredContent`
 * (preferred) or the first `content[].text` as JSON. Both are checked because
 * servers differ, and a missed challenge would be reported as a free call.
 */
function challengeIn(result: WrappedToolResult): Record<string, unknown> | null {
  const structured = (result as { structuredContent?: Record<string, unknown> }).structuredContent;
  if (structured && typeof structured === "object" && "accepts" in structured) {
    return structured;
  }

  for (const item of result.content ?? []) {
    if (item.type !== "text" || typeof item.text !== "string") continue;
    const parsed = safeExtract(() => JSON.parse(item.text) as unknown);
    if (parsed && typeof parsed === "object" && "accepts" in (parsed as object)) {
      return parsed as Record<string, unknown>;
    }
  }

  return null;
}

/** Run an extractor, treating a throw as "not present". */
function safeExtract<T>(read: () => T | null): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

export { PrometheusRegistry, prometheusHandler } from "@x402-lens/core";
export type { LensEvent, ToolResult, WrappedToolResult, MCPToolCallback };
