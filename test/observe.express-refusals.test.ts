/**
 * The Express observer's refusal paths and its `writeHead` variant.
 *
 * The observer wraps `setHeader`, `writeHead` and `json` on a live response, so a
 * throw in any of them takes down a request that was already answered correctly
 * by the SDK. These are the branches coverage reported as never taken:
 *
 *   72       a `PAYMENT-REQUIRED` header that cannot be decoded
 *   100-105  a header bag passed to `writeHead` instead of `setHeader`
 *   118      a body that is not an object to mirror into
 *
 * The `writeHead` case is not hypothetical: frameworks and test doubles pass the
 * header bag that way, and when only `setHeader` was watched an integration saw
 * no `payment.required` at all.
 */

import { EventEmitter } from "node:events";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { describe, expect, it } from "vitest";
import type { WirePaymentRequired } from "@x402-lens/core";
import { observePaymentRequired as observeExpress } from "../packages/express/src/observe.js";

const CHALLENGE: WirePaymentRequired = {
  x402Version: 2,
  resource: { url: "http://localhost/weather" },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:84532",
      amount: "1000",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      maxTimeoutSeconds: 60,
      extra: {},
    },
  ],
};

const ENCODED = encodePaymentRequiredHeader(CHALLENGE as never);

/** The minimum of an Express response the observer patches. */
class FakeResponse extends EventEmitter {
  statusCode = 200;
  headers: Record<string, unknown> = {};
  body: unknown;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  setHeader(name: string, value: unknown): this {
    this.headers[name.toLowerCase()] = value;
    return this;
  }

  writeHead(code: number, ...rest: unknown[]): this {
    this.statusCode = code;
    for (const candidate of rest) {
      if (candidate && typeof candidate === "object") {
        for (const [key, value] of Object.entries(candidate as Record<string, unknown>)) {
          this.headers[key.toLowerCase()] = value;
        }
      }
    }
    return this;
  }

  json(body: unknown): this {
    this.body = body;
    this.emit("finish");
    return this;
  }
}

describe("express observer: an undecodable header", () => {
  it("emits nothing and leaves the body alone", () => {
    const res = new FakeResponse();
    const seen: WirePaymentRequired[] = [];
    const stop = observeExpress(res as never, challenge => seen.push(challenge));

    res.setHeader("PAYMENT-REQUIRED", "not-a-challenge");
    res.status(402).json({ error: "Payment required" });
    stop();

    // The SDK's own body survives: the lens added nothing because it understood
    // nothing, which is the correct outcome for a header it cannot read.
    expect(seen).toHaveLength(0);
    expect(res.body).toEqual({ error: "Payment required" });
  });

  it("ignores a non-string header value", () => {
    const res = new FakeResponse();
    const seen: WirePaymentRequired[] = [];
    const stop = observeExpress(res as never, challenge => seen.push(challenge));

    // `setHeader` accepts numbers and arrays; neither can be a challenge.
    res.setHeader("PAYMENT-REQUIRED", 12345);
    res.status(402).json({});
    stop();

    expect(seen).toHaveLength(0);
  });
});

describe("express observer: the header bag passed to writeHead", () => {
  it("reports the challenge when writeHead carries the header", () => {
    const res = new FakeResponse();
    const seen: WirePaymentRequired[] = [];
    const stop = observeExpress(res as never, challenge => seen.push(challenge));

    // No setHeader at all — the header arrives in writeHead's bag.
    res.writeHead(402, { "PAYMENT-REQUIRED": ENCODED });
    stop();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.accepts?.[0]?.network).toBe("eip155:84532");
  });

  it("finds the header whatever its casing", () => {
    const res = new FakeResponse();
    const seen: WirePaymentRequired[] = [];
    const stop = observeExpress(res as never, challenge => seen.push(challenge));

    res.writeHead(402, { "payment-required": ENCODED });
    stop();

    expect(seen).toHaveLength(1);
  });

  it("tolerates non-object entries in the writeHead arguments", () => {
    // `writeHead(code, statusMessage, headers)` is a real overload, so a string
    // sits among the arguments.
    const res = new FakeResponse();
    const seen: WirePaymentRequired[] = [];
    const stop = observeExpress(res as never, challenge => seen.push(challenge));

    res.writeHead(402, "Payment Required", { "PAYMENT-REQUIRED": ENCODED });
    stop();

    expect(seen).toHaveLength(1);
  });

  it("does not report a header bag on a non-challenge status", () => {
    const res = new FakeResponse();
    const seen: WirePaymentRequired[] = [];
    const stop = observeExpress(res as never, challenge => seen.push(challenge));

    res.writeHead(500, { "PAYMENT-REQUIRED": ENCODED });
    stop();

    expect(seen).toHaveLength(0);
  });
});

describe("express observer: a body it cannot mirror into", () => {
  it("mirrors into an empty object when the body is an array", () => {
    const res = new FakeResponse();
    const stop = observeExpress(res as never, () => {});

    res.setHeader("PAYMENT-REQUIRED", ENCODED);
    res.status(402).json([1, 2, 3]);
    stop();

    // Spreading an array would turn its indices into keys; the mirror starts
    // from `{}` and the challenge fields are what the client needs.
    const body = res.body as Record<string, unknown>;
    expect(body.x402Version).toBe(2);
    expect(Array.isArray(body.accepts)).toBe(true);
    expect(body["0"]).toBeUndefined();
  });

  it("mirrors into an empty object when the body is a string", () => {
    const res = new FakeResponse();
    const stop = observeExpress(res as never, () => {});

    res.setHeader("PAYMENT-REQUIRED", ENCODED);
    res.status(402).json("Payment required");
    stop();

    expect((res.body as Record<string, unknown>).x402Version).toBe(2);
  });
});
