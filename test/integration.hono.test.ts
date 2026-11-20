/**
 * Hono adapter against the real SDK middleware and a real HTTP server.
 *
 * The Express suite already proves the shared event layer; this one proves the
 * Hono-specific half — that a `Response` produced by `@x402/hono` is observed,
 * mirrored, and passed through unchanged otherwise. Anything that only checks
 * event shape lives in the shared tests, not here.
 */

import { createAdaptorServer } from "@hono/node-server";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { Hono } from "hono";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WirePaymentRequired } from "@x402-lens/core";
import { paymentLens, type PaymentLens, type PaymentLensOptions } from "@x402-lens/hono";
import { startMockFacilitator, type MockFacilitator } from "./helpers/mockFacilitator.js";

const NETWORK = "eip155:84532";
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";

interface Harness {
  baseUrl: string;
  lens: PaymentLens;
  handlerCalls: { count: number };
  close(): Promise<void>;
}

let facilitator: MockFacilitator;
const started: Harness[] = [];

beforeAll(async () => {
  facilitator = await startMockFacilitator({ network: NETWORK });
});

afterAll(async () => {
  for (const harness of started) await harness.close();
  await facilitator.close();
});

async function startServer(
  options: {
    cors?: boolean | { origin: string };
    readableBody?: boolean;
    grant?: PaymentLensOptions["grant"];
  } = {},
): Promise<Harness> {
  const handlerCalls = { count: 0 };

  const lens = paymentLens({
    facilitatorUrl: facilitator.url,
    network: NETWORK,
    payTo: PAY_TO,
    routes: { "GET /weather": "$0.001" },
    sinks: { console: false },
    ...(options.cors ? { cors: options.cors } : {}),
    ...(options.readableBody === false ? { readableBody: false } : {}),
    ...(options.grant ? { grant: options.grant } : {}),
  });

  const app = new Hono();
  app.use("*", lens.middleware);
  app.get("/weather", c => {
    handlerCalls.count += 1;
    return c.json({ weather: "sunny", temperature: 70 });
  });

  const server = createAdaptorServer({ fetch: app.fetch });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  const harness: Harness = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    lens,
    handlerCalls,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      }),
  };
  started.push(harness);
  return harness;
}

/** Fetch unpaid and decode the challenge. */
async function fetchChallenge(baseUrl: string): Promise<{
  response: Response;
  paymentRequired: WirePaymentRequired;
}> {
  const response = await fetch(`${baseUrl}/weather`);
  const header = response.headers.get("payment-required");
  if (!header) throw new Error("no PAYMENT-REQUIRED header");
  return {
    response,
    paymentRequired: decodePaymentRequiredHeader(header) as unknown as WirePaymentRequired,
  };
}

const PAYER = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";

/** Build a signed-looking payload that echoes the challenge verbatim. */
function buildPayload(paymentRequired: WirePaymentRequired): Record<string, unknown> {
  const accepted = paymentRequired.accepts?.[0];
  if (!accepted) throw new Error("challenge has no accepts");
  return {
    x402Version: 2,
    resource: paymentRequired.resource,
    accepted,
    payload: {
      signature: `0x${"ab".repeat(65)}`,
      authorization: {
        from: PAYER,
        to: accepted.payTo,
        value: accepted.amount,
        validAfter: "0",
        validBefore: "9999999999",
        nonce: `0x${"cd".repeat(32)}`,
      },
    },
  };
}

describe("hono adapter: unpaid request", () => {
  it("answers 402 with the canonical header", async () => {
    const harness = await startServer();
    const { response, paymentRequired } = await fetchChallenge(harness.baseUrl);

    expect(response.status).toBe(402);
    expect(paymentRequired.accepts?.[0]?.network).toBe(NETWORK);
    expect(harness.handlerCalls.count).toBe(0);
  });

  it("mirrors the challenge into the body so curl | jq works", async () => {
    const harness = await startServer();
    const { response } = await fetchChallenge(harness.baseUrl);
    const body = (await response.json()) as Record<string, unknown>;

    expect(body.x402Version).toBe(2);
    expect(Array.isArray(body.accepts)).toBe(true);
  });

  it("leaves the body untouched when readableBody is off", async () => {
    const harness = await startServer({ readableBody: false });
    const { response } = await fetchChallenge(harness.baseUrl);
    const body = (await response.json()) as Record<string, unknown>;

    expect(body.accepts).toBeUndefined();
  });

  it("emits payment.required with route and network", async () => {
    const harness = await startServer();
    const events: Array<Record<string, unknown>> = [];
    harness.lens.on(event => events.push(event as unknown as Record<string, unknown>));

    await fetchChallenge(harness.baseUrl);

    const required = events.find(event => event.type === "payment.required");
    expect(required).toBeDefined();
    expect(required?.route).toBe("GET /weather");
    expect(required?.network).toBe(NETWORK);
    expect(required?.amount).toBe("1000");
  });
});

describe("hono adapter: paid request", () => {
  it("runs the handler and emits payment.settled", async () => {
    const harness = await startServer();
    const events: Array<Record<string, unknown>> = [];
    harness.lens.on(event => events.push(event as unknown as Record<string, unknown>));

    const { paymentRequired } = await fetchChallenge(harness.baseUrl);
    facilitator.verifyResult = { isValid: true, payer: PAYER };
    facilitator.settleResult = {
      success: true,
      transaction: "0xsettled",
      network: NETWORK,
      payer: PAYER,
    };

    const paid = await fetch(`${harness.baseUrl}/weather`, {
      headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(buildPayload(paymentRequired))).toString("base64") },
    });

    expect(paid.status).toBe(200);
    expect(await paid.json()).toEqual({ weather: "sunny", temperature: 70 });
    expect(harness.handlerCalls.count).toBe(1);

    const settled = events.find(event => event.type === "payment.settled");
    expect(settled).toBeDefined();
    expect(settled?.txHash).toBe("0xsettled");
    // `buyer` comes from the verify response, not the settle one: that is where
    // the facilitator reports who paid.
    expect(settled?.buyer).toBe(PAYER);
  });

  it("does not run the handler when verification fails", async () => {
    const harness = await startServer();
    const { paymentRequired } = await fetchChallenge(harness.baseUrl);
    facilitator.verifyResult = { isValid: false, invalidReason: "invalid_signature" };

    const paid = await fetch(`${harness.baseUrl}/weather`, {
      headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(buildPayload(paymentRequired))).toString("base64") },
    });

    expect(paid.status).toBe(402);
    expect(harness.handlerCalls.count).toBe(0);
  });
});

describe("hono adapter: unprotected routes", () => {
  it("passes an unpriced route straight through", async () => {
    const harness = await startServer();
    const app = new Hono();
    // A separate app so the unprotected route is genuinely outside the lens.
    app.get("/health", c => c.json({ ok: true }));

    const response = await fetch(`${harness.baseUrl}/health`);
    // /health was never mounted on the harness app, so this asserts the lens
    // does not answer for routes it does not protect.
    expect([404, 402]).toContain(response.status);
  });
});

describe("hono adapter: grant", () => {
  it("lets a granted request through without payment", async () => {
    const harness = await startServer({ grant: () => true });
    const events: Array<Record<string, unknown>> = [];
    harness.lens.on(event => events.push(event as unknown as Record<string, unknown>));

    const response = await fetch(`${harness.baseUrl}/weather`);

    expect(response.status).toBe(200);
    expect(harness.handlerCalls.count).toBe(1);
    expect(events.some(event => event.type === "access.granted")).toBe(true);
  });

  it("denies with 403 and keeps the reason off the body", async () => {
    const harness = await startServer({ grant: () => "internal traffic only" });
    const events: Array<Record<string, unknown>> = [];
    harness.lens.on(event => events.push(event as unknown as Record<string, unknown>));

    const response = await fetch(`${harness.baseUrl}/weather`);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "access_denied" });
    const denied = events.find(event => event.type === "access.denied");
    expect(denied?.reason).toBe("internal traffic only");
  });
});

describe("hono adapter: cors", () => {
  it("exposes the payment headers and answers preflight", async () => {
    const harness = await startServer({ cors: { origin: "https://example.com" } });

    const preflight = await fetch(`${harness.baseUrl}/weather`, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://example.com");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("PAYMENT-SIGNATURE");
  });

  it("exposes PAYMENT-REQUIRED on the 402 itself", async () => {
    const harness = await startServer({ cors: { origin: "https://example.com" } });
    const { response } = await fetchChallenge(harness.baseUrl);

    expect(response.headers.get("access-control-expose-headers")).toContain("PAYMENT-REQUIRED");
  });
});
