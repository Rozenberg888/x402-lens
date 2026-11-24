/**
 * The observer must notice a challenge on any status the SDK can send it on.
 *
 * The SDK sends `permit2_allowance_required` as **412**, not 402: the buyer's
 * token allowance must be granted before a payment can even be attempted, so the
 * server answers 412 with the same `PAYMENT-REQUIRED` challenge. Both adapters
 * gated on 402 alone, which silently dropped that exchange from the event stream
 * — the one case where the buyer is being asked to do something extra.
 *
 * These tests drive the observers directly rather than through the official
 * middleware, because the SDK only emits 412 from a real permit2 facilitator and
 * that cannot be reproduced against the mock. What is being pinned here is the
 * observer's status gate, which is the part that was wrong.
 */

import { EventEmitter } from "node:events";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { describe, expect, it } from "vitest";
import type { WirePaymentRequired } from "@x402-lens/core";
import { CHALLENGE_STATUSES, isChallengeStatus } from "@x402-lens/server";
import { observePaymentRequired as observeExpress } from "../packages/express/src/observe.js";
import { observePaymentRequired as observeHono } from "../packages/hono/src/observe.js";

const CHALLENGE: WirePaymentRequired = {
  x402Version: 2,
  error: "permit2_allowance_required",
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

/** Just enough of an Express response for the observer to patch. */
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

describe("isChallengeStatus", () => {
  it("accepts 402 and 412", () => {
    expect(isChallengeStatus(402)).toBe(true);
    expect(isChallengeStatus(412)).toBe(true);
  });

  it("rejects everything else, including the near-misses", () => {
    for (const status of [200, 400, 401, 403, 404, 409, 411, 413, 500, 502]) {
      expect(isChallengeStatus(status)).toBe(false);
    }
  });

  it("exposes exactly the two statuses the SDK can send a challenge on", () => {
    expect([...CHALLENGE_STATUSES].sort((a, b) => a - b)).toEqual([402, 412]);
  });
});

describe("express observer: challenge statuses", () => {
  it("reports the challenge on a 412 permit2 response", () => {
    const res = new FakeResponse();
    const seen: WirePaymentRequired[] = [];
    const stop = observeExpress(res as never, challenge => seen.push(challenge));

    // This is the shape the SDK produces: setHeader, then status, then json.
    res.setHeader("PAYMENT-REQUIRED", ENCODED);
    res.status(412).json({ error: "permit2_allowance_required" });

    stop();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.accepts?.[0]?.network).toBe("eip155:84532");
  });

  it("still mirrors the challenge into the 412 body", () => {
    const res = new FakeResponse();
    const stop = observeExpress(res as never, () => {});

    res.setHeader("PAYMENT-REQUIRED", ENCODED);
    res.status(412).json({ error: "permit2_allowance_required" });
    stop();

    const body = res.body as Record<string, unknown>;
    expect(body.error).toBe("permit2_allowance_required");
    expect(Array.isArray(body.accepts)).toBe(true);
  });

  it("still reports a plain 402 unchanged", () => {
    const res = new FakeResponse();
    const seen: WirePaymentRequired[] = [];
    const stop = observeExpress(res as never, challenge => seen.push(challenge));

    res.setHeader("PAYMENT-REQUIRED", ENCODED);
    res.status(402).json({});
    stop();

    expect(seen).toHaveLength(1);
  });

  it("does not report a challenge on a non-challenge status", () => {
    const res = new FakeResponse();
    const seen: WirePaymentRequired[] = [];
    const stop = observeExpress(res as never, challenge => seen.push(challenge));

    // A 500 that happens to carry the header is a server bug, not a paywall.
    res.setHeader("PAYMENT-REQUIRED", ENCODED);
    res.status(500).json({ error: "boom" });
    stop();

    expect(seen).toHaveLength(0);
    expect(res.body).toEqual({ error: "boom" });
  });
});

describe("hono observer: challenge statuses", () => {
  it("reports the challenge on a 412 permit2 response", async () => {
    const seen: WirePaymentRequired[] = [];
    const response = new Response(JSON.stringify({ error: "permit2_allowance_required" }), {
      status: 412,
      headers: { "content-type": "application/json", "payment-required": ENCODED },
    });

    const out = await observeHono(response, challenge => seen.push(challenge));

    expect(seen).toHaveLength(1);
    expect(out.status).toBe(412);
    const body = (await out.json()) as Record<string, unknown>;
    expect(body.error).toBe("permit2_allowance_required");
    expect(Array.isArray(body.accepts)).toBe(true);
  });

  it("passes a non-challenge status through untouched", async () => {
    const seen: WirePaymentRequired[] = [];
    const response = new Response(JSON.stringify({ error: "boom" }), {
      status: 500,
      headers: { "content-type": "application/json", "payment-required": ENCODED },
    });

    const out = await observeHono(response, challenge => seen.push(challenge));

    expect(seen).toHaveLength(0);
    expect(out).toBe(response);
  });
});
