/**
 * Ready-made exporters for production observability stacks.
 *
 * None of these pull OpenTelemetry, Prometheus client, or Sentry as
 * dependencies. Each exporter speaks the smallest public surface those tools
 * expose, so an app that already has them wired can pass the handle in; an app
 * that does not still compiles.
 */

import type { LensEvent, LensEventType } from "./events.js";
import type { LensSink } from "./sinks.js";

/** Counters and a latency histogram, rendered as Prometheus text. */
export class PrometheusRegistry {
  private readonly counters = new Map<string, number>();
  private readonly durationsMs: number[] = [];
  private readonly maxSamples: number;

  constructor(options: { maxSamples?: number } = {}) {
    this.maxSamples = options.maxSamples ?? 10_000;
  }

  /** Record one lens event. Safe to call from a sink. */
  record(event: LensEvent): void {
    this.bump(`x402_lens_events_total{type="${escapeLabel(event.type)}"}`);
    if (event.type === "payment.failed" || event.type === "payment.settle_failed") {
      this.bump(`x402_lens_failures_total{type="${escapeLabel(event.type)}"}`);
    }
    if (event.type === "payment.settled") {
      this.bump("x402_lens_settlements_total");
    }
    if (typeof event.durationMs === "number" && Number.isFinite(event.durationMs)) {
      if (this.durationsMs.length >= this.maxSamples) this.durationsMs.shift();
      this.durationsMs.push(event.durationMs);
    }
  }

  /** Prometheus exposition format, ready for `/metrics`. */
  render(): string {
    const lines: string[] = [
      "# HELP x402_lens_events_total x402-lens events by type",
      "# TYPE x402_lens_events_total counter",
    ];
    for (const [key, value] of [...this.counters.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      lines.push(`${key} ${value}`);
    }

    if (this.durationsMs.length > 0) {
      const sorted = [...this.durationsMs].sort((a, b) => a - b);
      const sum = sorted.reduce((acc, value) => acc + value, 0);
      lines.push("# HELP x402_lens_event_duration_ms Event duration samples");
      lines.push("# TYPE x402_lens_event_duration_ms summary");
      lines.push(`x402_lens_event_duration_ms{quantile="0.5"} ${quantile(sorted, 0.5)}`);
      lines.push(`x402_lens_event_duration_ms{quantile="0.9"} ${quantile(sorted, 0.9)}`);
      lines.push(`x402_lens_event_duration_ms{quantile="0.99"} ${quantile(sorted, 0.99)}`);
      lines.push(`x402_lens_event_duration_ms_sum ${sum}`);
      lines.push(`x402_lens_event_duration_ms_count ${sorted.length}`);
    }

    return `${lines.join("\n")}\n`;
  }

  /** Reset all counters. Useful in tests. */
  reset(): void {
    this.counters.clear();
    this.durationsMs.length = 0;
  }

  private bump(key: string): void {
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }
}

/** Shared registry used when callers do not pass their own. */
export const defaultPrometheusRegistry = new PrometheusRegistry();

/**
 * Sink that feeds a Prometheus registry.
 *
 * Mount `prometheusHandler(registry)` on `/metrics` in Express, or call
 * `registry.render()` from any HTTP framework.
 */
export function prometheusSink(
  registry: PrometheusRegistry = defaultPrometheusRegistry,
): LensSink {
  return {
    name: "prometheus",
    write(event) {
      registry.record(event);
    },
  };
}

/**
 * Minimal Node HTTP / Express handler that serves the Prometheus text format.
 *
 * Compatible with `(req, res) => …` and with frameworks that expose
 * `setHeader` / `end` the same way.
 */
export function prometheusHandler(
  registry: PrometheusRegistry = defaultPrometheusRegistry,
): (req: unknown, res: {
  setHeader(name: string, value: string): void;
  statusCode?: number;
  end(body: string): void;
}) => void {
  return (_req, res) => {
    res.statusCode = 200;
    res.setHeader("content-type", "text/plain; version=0.0.4; charset=utf-8");
    res.end(registry.render());
  };
}

/** Subset of the OpenTelemetry Tracer API we need. */
export interface OtelTracerLike {
  startSpan(name: string, options?: { attributes?: Record<string, string | number | boolean> }): {
    setAttribute(key: string, value: string | number | boolean): void;
    setStatus?(status: { code: number; message?: string }): void;
    end(): void;
  };
}

/**
 * Sink that opens a short span per event on a caller-supplied tracer.
 *
 * Pass `trace.getTracer("x402-lens")` from `@opentelemetry/api`. The package
 * itself is not a dependency of x402-lens.
 */
export function openTelemetrySink(tracer: OtelTracerLike): LensSink {
  return {
    name: "opentelemetry",
    write(event) {
      const span = tracer.startSpan(`x402.${event.type}`, {
        attributes: {
          "x402.event": event.type,
          "x402.route": event.route,
          "x402.network": event.network,
          "x402.amount": event.amount,
          "x402.scheme": event.scheme,
        },
      });
      if (event.buyer) span.setAttribute("x402.buyer", event.buyer);
      if ("txHash" in event && event.txHash) span.setAttribute("x402.tx_hash", event.txHash);
      if (isFailureEvent(event.type)) {
        span.setStatus?.({ code: 2, message: event.type });
      }
      span.end();
    },
  };
}

/** Subset of the Sentry scope / hub API we need. */
export interface SentryLike {
  addBreadcrumb(breadcrumb: {
    category?: string;
    message?: string;
    level?: "info" | "warning" | "error";
    data?: Record<string, unknown>;
  }): void;
}

/**
 * Sink that records each event as a Sentry breadcrumb.
 *
 * Pass the Sentry module (`import * as Sentry from "@sentry/node"`) or any
 * object with `addBreadcrumb`. Sentry is not a dependency of x402-lens.
 */
export function sentryBreadcrumbSink(sentry: SentryLike): LensSink {
  return {
    name: "sentry",
    write(event) {
      sentry.addBreadcrumb({
        category: "x402",
        message: event.type,
        level: sentryLevel(event.type),
        data: {
          route: event.route,
          network: event.network,
          amount: event.amount,
          buyer: event.buyer,
          ...("txHash" in event ? { txHash: event.txHash } : {}),
          ...("reason" in event ? { reason: event.reason } : {}),
        },
      });
    },
  };
}

function isFailureEvent(type: LensEventType): boolean {
  return (
    type === "payment.failed" ||
    type === "payment.settle_failed" ||
    type === "facilitator.error" ||
    type === "access.denied"
  );
}

function sentryLevel(type: LensEventType): "info" | "warning" | "error" {
  if (type === "payment.failed" || type === "payment.settle_failed" || type === "facilitator.error") {
    return "error";
  }
  if (type === "payment.canceled" || type === "access.denied") return "warning";
  return "info";
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index] ?? 0;
}
