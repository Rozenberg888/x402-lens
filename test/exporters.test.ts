/**
 * Ready-made exporters: Prometheus text, OpenTelemetry spans, Sentry breadcrumbs.
 */

import { describe, expect, it } from "vitest";
import {
  PrometheusRegistry,
  makeEvent,
  openTelemetrySink,
  prometheusHandler,
  prometheusSink,
  sentryBreadcrumbSink,
  type LensEvent,
} from "@x402-lens/core";

function sample(type: LensEvent["type"], extra: Partial<LensEvent> = {}): LensEvent {
  return makeEvent({
    type,
    requestId: "req-1",
    route: "GET /weather",
    scheme: "exact",
    network: "eip155:84532",
    amount: "1000",
    asset: "0xabc",
    payTo: "0xdef",
    durationMs: 12,
    ...extra,
  } as LensEvent);
}

describe("prometheus exporter", () => {
  it("counts events and renders Prometheus text", () => {
    const registry = new PrometheusRegistry();
    const sink = prometheusSink(registry);

    sink.write(sample("payment.required"));
    sink.write(sample("payment.settled", { type: "payment.settled", txHash: "0x1" }));
    sink.write(sample("payment.failed", { type: "payment.failed", reason: "nope" }));

    const text = registry.render();
    expect(text).toContain('x402_lens_events_total{type="payment.required"} 1');
    expect(text).toContain('x402_lens_events_total{type="payment.settled"} 1');
    expect(text).toContain("x402_lens_settlements_total 1");
    expect(text).toContain('x402_lens_failures_total{type="payment.failed"} 1');
    expect(text).toContain("x402_lens_event_duration_ms_count 3");
  });

  it("serves /metrics through the handler", () => {
    const registry = new PrometheusRegistry();
    registry.record(sample("payment.verified"));
    const handler = prometheusHandler(registry);

    let body = "";
    let contentType = "";
    handler(undefined, {
      setHeader(name, value) {
        if (name === "content-type") contentType = value;
      },
      end(payload) {
        body = payload;
      },
    });

    expect(contentType).toContain("text/plain");
    expect(body).toContain("payment.verified");
  });
});

describe("opentelemetry exporter", () => {
  it("opens a span per event with x402 attributes", () => {
    const spans: Array<{ name: string; attributes: Record<string, unknown>; status?: unknown }> =
      [];
    const sink = openTelemetrySink({
      startSpan(name, options) {
        const attributes = { ...(options?.attributes ?? {}) };
        const span = {
          setAttribute(key: string, value: string | number | boolean) {
            attributes[key] = value;
          },
          setStatus(status: { code: number; message?: string }) {
            spans[spans.length - 1]!.status = status;
          },
          end() {},
        };
        spans.push({ name, attributes });
        return span;
      },
    });

    sink.write(sample("payment.failed", { type: "payment.failed", reason: "x", buyer: "0x1" }));

    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe("x402.payment.failed");
    expect(spans[0]?.attributes["x402.route"]).toBe("GET /weather");
    expect(spans[0]?.attributes["x402.buyer"]).toBe("0x1");
    expect(spans[0]?.status).toEqual({ code: 2, message: "payment.failed" });
  });
});

describe("sentry exporter", () => {
  it("records breadcrumbs with severity matching the event", () => {
    const crumbs: Array<Record<string, unknown>> = [];
    const sink = sentryBreadcrumbSink({
      addBreadcrumb(breadcrumb) {
        crumbs.push(breadcrumb);
      },
    });

    sink.write(sample("payment.settled", { type: "payment.settled", txHash: "0xabc" }));
    sink.write(sample("payment.settle_failed", { type: "payment.settle_failed", reason: "x" }));

    expect(crumbs[0]?.level).toBe("info");
    expect(crumbs[0]?.data).toMatchObject({ txHash: "0xabc" });
    expect(crumbs[1]?.level).toBe("error");
    expect(crumbs[1]?.category).toBe("x402");
  });
});
