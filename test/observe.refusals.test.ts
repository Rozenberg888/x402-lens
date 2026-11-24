/**
 * The observer's refusal paths.
 *
 * Every branch here exists so that a malformed response cannot break the payment
 * path: the observer runs *after* the SDK has produced an answer, so a throw at
 * this point turns a valid 402 into a 500 for a buyer who did nothing wrong.
 *
 * Coverage showed these three branches were never taken — the happy path was
 * covered from both adapters, the refusals from neither.
 */

import { describe, expect, it } from "vitest";
import type { WirePaymentRequired } from "@x402-lens/core";
import { observePaymentRequired as observeHono } from "../packages/hono/src/observe.js";

/** A response carrying whatever header value is given. */
function withHeader(value: string, body = "{}"): Response {
  return new Response(body, {
    status: 402,
    headers: { "content-type": "application/json", "payment-required": value },
  });
}

describe("hono observer: an undecodable header", () => {
  it("returns the response untouched instead of throwing", async () => {
    const original = withHeader("not-base64-and-not-json");
    const seen: WirePaymentRequired[] = [];

    const result = await observeHono(original, challenge => seen.push(challenge));

    // Same object: nothing was rebuilt, nothing was mirrored, no event fired.
    expect(result).toBe(original);
    expect(seen).toHaveLength(0);
  });

  it("does not mirror an undecodable challenge into the body", async () => {
    const result = await observeHono(withHeader("garbage"), () => {});

    expect(await result.json()).toEqual({});
  });
});

describe("hono observer: a body it cannot mirror", () => {
  it("leaves a non-JSON body alone", async () => {
    // Browsers get an HTML paywall; rewriting it as JSON would replace the page
    // with `{"x402Version":2,…}`.
    const encoded = Buffer.from(
      JSON.stringify({ x402Version: 2, accepts: [] }),
      "utf8",
    ).toString("base64");
    const original = new Response("<html>pay up</html>", {
      status: 402,
      headers: { "content-type": "text/html", "payment-required": encoded },
    });
    const seen: WirePaymentRequired[] = [];

    const result = await observeHono(original, challenge => seen.push(challenge));

    // The challenge is still reported — that half must not depend on the body.
    expect(seen).toHaveLength(1);
    expect(result).toBe(original);
    expect(await result.text()).toBe("<html>pay up</html>");
  });

  it("treats a JSON array body as no body", async () => {
    const encoded = Buffer.from(
      JSON.stringify({ x402Version: 2, accepts: [] }),
      "utf8",
    ).toString("base64");
    const original = new Response("[]", {
      status: 402,
      headers: { "content-type": "application/json", "payment-required": encoded },
    });

    const result = await observeHono(original, () => {});

    // An array has no fields to merge into, so the mirror starts from `{}` rather
    // than spreading an array's indices as keys.
    expect(await result.json()).toEqual({ x402Version: 2, accepts: [] });
  });

  it("survives a body that is not valid JSON at all", async () => {
    const encoded = Buffer.from(
      JSON.stringify({ x402Version: 2, accepts: [] }),
      "utf8",
    ).toString("base64");
    const original = new Response("{not json", {
      status: 402,
      headers: { "content-type": "application/json", "payment-required": encoded },
    });

    const result = await observeHono(original, () => {});

    expect(await result.json()).toEqual({ x402Version: 2, accepts: [] });
  });

  it("survives a body that was already consumed", async () => {
    // A server that read its own body before handing the response back leaves a
    // locked stream. `clone()` throws, and that must not become a 500.
    const encoded = Buffer.from(
      JSON.stringify({ x402Version: 2, accepts: [] }),
      "utf8",
    ).toString("base64");
    const original = new Response('{"a":1}', {
      status: 402,
      headers: { "content-type": "application/json", "payment-required": encoded },
    });
    await original.text();

    const result = await observeHono(original, () => {});

    expect(result.status).toBe(402);
  });
});
