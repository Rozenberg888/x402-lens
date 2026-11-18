/**
 * Sink behaviour.
 *
 * Two claims in the README are load-bearing and untested until now: a failing
 * sink never breaks a payment, and a JSONL file never contains a half-written
 * line under concurrent requests.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EventBus,
  callbackSink,
  consoleSink,
  formatEventLine,
  jsonlFileSink,
  type LensEvent,
  type LensSink,
} from "@x402-lens/core";

const temporaryDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "x402-lens-sink-"));
  temporaryDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })),
  );
});

function settledEvent(overrides: Partial<LensEvent> = {}): LensEvent {
  return {
    type: "payment.settled",
    ts: "2026-01-01T00:00:00.000Z",
    requestId: "req-1",
    route: "GET /weather",
    scheme: "exact",
    network: "eip155:84532",
    amount: "1000",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    buyer: "0x857b06519E91e3A54538791bDAbd0E22373e36b66",
    txHash: "0xabc",
    ...overrides,
  } as LensEvent;
}

describe("EventBus", () => {
  it("delivers every event to every sink", () => {
    const a: LensEvent[] = [];
    const b: LensEvent[] = [];
    const bus = new EventBus([callbackSink(event => a.push(event)), callbackSink(event => b.push(event))]);

    bus.emit(settledEvent());

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it("logs to console.error by default when a sink throws", () => {
    const lines: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args);
    };
    try {
      const broken: LensSink = {
        name: "broken",
        write() {
          throw new Error("exporter is down");
        },
      };
      const bus = new EventBus([broken]);
      expect(() => bus.emit(settledEvent())).not.toThrow();
      expect(String(lines[0]?.[0] ?? "")).toContain('sink "broken" failed');
    } finally {
      console.error = original;
    }
  });

  it("reports a throwing close() without aborting other sinks", async () => {
    const closed: string[] = [];
    const errors: unknown[] = [];
    const broken: LensSink = {
      name: "broken-close",
      write() {},
      close() {
        throw new Error("flush failed");
      },
    };
    const ok: LensSink = {
      name: "ok-close",
      write() {},
      async close() {
        closed.push("ok-close");
      },
    };
    const bus = new EventBus([broken, ok], error => errors.push(error));
    await bus.close();
    expect(closed).toEqual(["ok-close"]);
    expect(errors.length).toBe(1);
    // Further emits are ignored after close.
    bus.emit(settledEvent());
    expect(closed).toEqual(["ok-close"]);
  });

  it("keeps going when one sink throws", () => {
    const delivered: LensEvent[] = [];
    const errors: unknown[] = [];
    const broken: LensSink = {
      name: "broken",
      write() {
        throw new Error("broker is down");
      },
    };

    const bus = new EventBus([broken, callbackSink(event => delivered.push(event))], error =>
      errors.push(error),
    );

    expect(() => bus.emit(settledEvent())).not.toThrow();
    expect(delivered).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  it("keeps going when one sink rejects asynchronously", async () => {
    const delivered: LensEvent[] = [];
    const broken: LensSink = {
      name: "broken-async",
      write() {
        return Promise.reject(new Error("flush failed"));
      },
    };

    const bus = new EventBus([broken, callbackSink(event => delivered.push(event))], () => {});
    bus.emit(settledEvent());
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(delivered).toHaveLength(1);
    // An unhandled rejection here would fail the suite; reaching this line and
    // the assertion above is the point of the test.
    expect(true).toBe(true);
  });

  it("stops emitting after close and flushes sinks once", async () => {
    let closed = 0;
    const delivered: LensEvent[] = [];
    const bus = new EventBus([
      {
        name: "counting",
        write(event) {
          delivered.push(event);
        },
        close() {
          closed += 1;
        },
      },
    ]);

    bus.emit(settledEvent());
    await bus.close();
    bus.emit(settledEvent());

    expect(delivered).toHaveLength(1);
    expect(closed).toBe(1);
  });

  it("removes a sink without disturbing the others", () => {
    const kept: LensEvent[] = [];
    const removed: LensEvent[] = [];
    const removable = callbackSink(event => removed.push(event));
    const bus = new EventBus([callbackSink(event => kept.push(event)), removable]);

    bus.emit(settledEvent());
    bus.remove(removable);
    bus.emit(settledEvent());

    expect(kept).toHaveLength(2);
    expect(removed).toHaveLength(1);
  });
});

describe("jsonlFileSink", () => {
  it("creates missing directories and writes one JSON object per line", async () => {
    const dir = await tempDir();
    const path = join(dir, "nested", "deeper", "events.jsonl");
    const sink = jsonlFileSink(path);

    sink.write(settledEvent({ requestId: "a" }));
    sink.write(settledEvent({ requestId: "b" }));
    await sink.close?.();

    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.map(line => (JSON.parse(line) as { requestId: string }).requestId)).toEqual([
      "a",
      "b",
    ]);
  });

  it("does not interleave lines when writes arrive concurrently", async () => {
    const dir = await tempDir();
    const path = join(dir, "events.jsonl");
    const sink = jsonlFileSink(path);

    const total = 50;
    for (let index = 0; index < total; index += 1) {
      sink.write(settledEvent({ requestId: `req-${index}` }));
    }
    await sink.close?.();

    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(total);
    // Every line must parse on its own; a torn line would throw here.
    const ids = lines.map(line => (JSON.parse(line) as { requestId: string }).requestId);
    expect(new Set(ids).size).toBe(total);
  });

  it("swallows a write failure rather than breaking the payment path", async () => {
    // A directory where the file should be: the append fails every time.
    const dir = await tempDir();
    const sink = jsonlFileSink(dir);

    expect(() => sink.write(settledEvent())).not.toThrow();
    await expect(sink.close?.()).resolves.toBeUndefined();
  });

  it("logs a write failure to stderr once", async () => {
    const dir = await tempDir();
    const sink = jsonlFileSink(dir);
    const lines: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;

    try {
      sink.write(settledEvent({ requestId: "one" }));
      sink.write(settledEvent({ requestId: "two" }));
      await sink.close?.();
    } finally {
      process.stderr.write = original;
    }

    const warnings = lines.filter(line => line.includes("jsonl sink write failed"));
    expect(warnings).toHaveLength(1);
  });
});

describe("consoleSink", () => {
  it("writes failures to stderr and everything else to stdout", () => {
    const out: string[] = [];
    const err: string[] = [];
    const sink = consoleSink({
      log: (line: string) => out.push(line),
      error: (line: string) => err.push(line),
    });

    sink.write(settledEvent());
    sink.write(settledEvent({ type: "payment.failed", reason: "invalid_exact_evm_payload_signature" }) as LensEvent);

    expect(out).toHaveLength(1);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain("invalid_exact_evm_payload_signature");
  });
});

describe("formatEventLine", () => {
  it("carries the fields an operator greps for", () => {
    const line = formatEventLine(settledEvent());
    expect(line).toContain("SETTLED");
    expect(line).toContain("GET /weather");
    expect(line).toContain("eip155:84532");
    expect(line).toContain("tx=0xabc");
  });

  it("prints one indented line per finding", () => {
    const line = formatEventLine({
      ...settledEvent({ type: "payment.failed", reason: "invalid_exact_evm_payload_signature" }),
      findings: [
        {
          severity: "error",
          code: "signature_mismatch",
          field: "payment.payload.signature",
          problem: "bad",
          fix: "re-sign",
        },
      ],
    } as LensEvent);

    const lines = line.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("signature_mismatch");
    expect(lines[1]).toContain("payment.payload.signature");
  });
});
