/**
 * End-to-end behaviour against the real `@x402/express` middleware, with a
 * stand-in facilitator.
 *
 * These are the acceptance tests from the brief: an unpaid request gets a 402
 * with correct v2 fields; an invalid signature gets a 402 without the handler
 * running; a valid one reaches the handler and is settled.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { WirePaymentRequired } from "@x402-lens/core";
import { paymentLens, type PaymentLens } from "@x402-lens/express";
import { startMockFacilitator, type MockFacilitator } from "./helpers/mockFacilitator";

const NETWORK = "eip155:84532";
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const PAYER = "0x857b06519E91e3A54538791bDAbd0E22373e36b66";

interface Harness {
  baseUrl: string;
  lens: PaymentLens;
  /** Incremented by the protected handler. */
  handlerCalls: { count: number };
  close(): Promise<void>;
}

let facilitator: MockFacilitator;
let harness: Harness;

beforeAll(async () => {
  facilitator = await startMockFacilitator({ network: NETWORK });
  harness = await startServer(facilitator.url);
});

afterAll(async () => {
  await harness.close();
  await facilitator.close();
});

async function startServer(
  facilitatorUrl: string,
  options: { cors?: boolean; ownCors?: boolean; readableBody?: boolean } = {},
): Promise<Harness> {
  const handlerCalls = { count: 0 };

  const lens = paymentLens({
    facilitatorUrl,
    network: NETWORK,
    payTo: PAY_TO,
    routes: { "GET /weather": "$0.001" },
    sinks: { console: false },
    ...(options.cors ? { cors: true } : {}),
    ...(options.readableBody === false ? { readableBody: false } : {}),
  });

  const app = express();
  if (options.ownCors) {
    // Stands in for an app that already runs its own CORS middleware.
    app.use((_req, res, next) => {
      res.setHeader("Access-Control-Expose-Headers", "X-Custom-Header");
      next();
    });
  }
  app.use(lens.middleware);
  app.get("/weather", (_req, res) => {
    handlerCalls.count += 1;
    res.json({ weather: "sunny", temperature: 70 });
  });

  const server: Server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    lens,
    handlerCalls,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      }),
  };
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

function encodeHeader(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

describe("unpaid request", () => {
  it("returns 402", async () => {
    const response = await fetch(`${harness.baseUrl}/weather`);
    expect(response.status).toBe(402);
    expect(harness.handlerCalls.count).toBe(0);
  });

  it("carries a PAYMENT-REQUIRED header with the required v2 fields", async () => {
    const { paymentRequired } = await fetchChallenge(harness.baseUrl);

    expect(paymentRequired.x402Version).toBe(2);
    expect(Array.isArray(paymentRequired.accepts)).toBe(true);
    expect(paymentRequired.accepts?.length).toBeGreaterThan(0);

    const accept = paymentRequired.accepts?.[0];
    expect(accept?.scheme).toBe("exact");
    expect(accept?.network).toBe(NETWORK);
    expect(accept?.amount).toMatch(/^\d+$/);
    expect(accept?.asset).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(accept?.payTo).toBe(PAY_TO);
    expect(typeof accept?.maxTimeoutSeconds).toBe("number");

    expect(paymentRequired.resource?.url).toBeTruthy();
  });

  it("mirrors the challenge into the JSON body so curl | jq works", async () => {
    const { response } = await fetchChallenge(harness.baseUrl);
    const body = (await response.json()) as Record<string, unknown>;

    expect(body.x402Version).toBe(2);
    expect(Array.isArray(body.accepts)).toBe(true);
  });
});

describe("invalid payment", () => {
  it("returns 402 without calling the handler when the facilitator rejects", async () => {
    const { paymentRequired } = await fetchChallenge(harness.baseUrl);
    facilitator.verifyResult = {
      isValid: false,
      invalidReason: "invalid_exact_evm_payload_signature",
      payer: PAYER,
    };

    const before = harness.handlerCalls.count;
    const response = await fetch(`${harness.baseUrl}/weather`, {
      headers: { "PAYMENT-SIGNATURE": encodeHeader(buildPayload(paymentRequired)) },
    });

    expect(response.status).toBe(402);
    expect(harness.handlerCalls.count).toBe(before);

    facilitator.verifyResult = { isValid: true, payer: PAYER };
  });

  it("returns 402 when the signature header is not decodable", async () => {
    const before = harness.handlerCalls.count;
    // The SDK logs the decode failure to stderr; that is the behaviour under
    // test, so keep it out of the suite output.
    const originalError = console.error;
    console.error = () => {};
    try {
      const response = await fetch(`${harness.baseUrl}/weather`, {
        headers: { "PAYMENT-SIGNATURE": "not-base64-at-all!!!" },
      });

      expect(response.status).toBe(402);
      expect(harness.handlerCalls.count).toBe(before);
    } finally {
      console.error = originalError;
    }
  });
});

describe("valid payment", () => {
  it("reaches the handler and settles", async () => {
    const { paymentRequired } = await fetchChallenge(harness.baseUrl);
    const before = harness.handlerCalls.count;

    const response = await fetch(`${harness.baseUrl}/weather`, {
      headers: { "PAYMENT-SIGNATURE": encodeHeader(buildPayload(paymentRequired)) },
    });

    expect(response.status).toBe(200);
    expect(harness.handlerCalls.count).toBe(before + 1);
    expect(await response.json()).toEqual({ weather: "sunny", temperature: 70 });

    const settleHeader = response.headers.get("payment-response");
    expect(settleHeader).toBeTruthy();
    const settled = JSON.parse(
      Buffer.from(settleHeader as string, "base64").toString("utf8"),
    ) as { success: boolean; transaction: string; network: string };
    expect(settled.success).toBe(true);
    expect(settled.transaction).toMatch(/^0x[0-9a-f]+$/i);
    expect(settled.network).toBe(NETWORK);
  });

  it("does not call the handler when settlement fails", async () => {
    const { paymentRequired } = await fetchChallenge(harness.baseUrl);
    facilitator.settleResult = {
      success: false,
      errorReason: "insufficient_funds",
      transaction: "",
      network: NETWORK,
      payer: PAYER,
    };

    // The handler runs before settlement in the authorization flow, so the
    // response is what changes: no buffered body is sent on settle failure.
    const response = await fetch(`${harness.baseUrl}/weather`, {
      headers: { "PAYMENT-SIGNATURE": encodeHeader(buildPayload(paymentRequired)) },
    });

    expect(response.status).toBe(402);

    facilitator.settleResult = {
      success: true,
      transaction: `0x${"11".repeat(32)}`,
      network: NETWORK,
      payer: PAYER,
    };
  });
});

describe("events", () => {
  it("emits payment.required, payment.verified and payment.settled with the required fields", async () => {
    const events: Array<Record<string, unknown>> = [];
    const unsubscribe = harness.lens.on(event => events.push(event as unknown as Record<string, unknown>));

    const { paymentRequired } = await fetchChallenge(harness.baseUrl);
    await fetch(`${harness.baseUrl}/weather`, {
      headers: { "PAYMENT-SIGNATURE": encodeHeader(buildPayload(paymentRequired)) },
    });
    unsubscribe();

    const types = events.map(event => event.type);
    expect(types).toContain("payment.required");
    expect(types).toContain("payment.verified");
    expect(types).toContain("payment.settled");

    const settled = events.find(event => event.type === "payment.settled");
    expect(settled).toMatchObject({
      route: "GET /weather",
      network: NETWORK,
      payTo: PAY_TO,
      buyer: PAYER,
    });
    expect(settled?.amount).toMatch(/^\d+$/);
    expect(settled?.txHash).toMatch(/^0x[0-9a-f]+$/i);
    expect(typeof settled?.ts).toBe("string");
  });

  it("attaches findings explaining a rejection", async () => {
    const events: Array<Record<string, unknown>> = [];
    const unsubscribe = harness.lens.on(event => events.push(event as unknown as Record<string, unknown>));

    const { paymentRequired } = await fetchChallenge(harness.baseUrl);
    facilitator.verifyResult = {
      isValid: false,
      invalidReason: "invalid_exact_evm_payload_signature",
      payer: PAYER,
    };

    await fetch(`${harness.baseUrl}/weather`, {
      headers: { "PAYMENT-SIGNATURE": encodeHeader(buildPayload(paymentRequired)) },
    });
    unsubscribe();

    const failed = events.find(event => event.type === "payment.failed");
    expect(failed).toBeTruthy();
    expect(failed?.reason).toBe("invalid_exact_evm_payload_signature");

    const findings = failed?.findings as Array<{ code: string; fix: string }>;
    expect(findings.some(finding => finding.code === "signature_mismatch")).toBe(true);
    expect(findings[0]?.fix).toContain("verifyingContract");

    facilitator.verifyResult = { isValid: true, payer: PAYER };
  });
});

describe("unprotected route", () => {
  it("passes through without payment", async () => {
    // `/health` is not in the route map, so the middleware must not interfere.
    const response = await fetch(`${harness.baseUrl}/health`);
    expect(response.status).toBe(404);
    expect(response.headers.get("payment-required")).toBeNull();
  });
});

describe("readableBody: false", () => {
  it("still emits events but leaves the 402 body alone", async () => {
    const raw = await startServer(facilitator.url, { readableBody: false });
    try {
      const events: Array<Record<string, unknown>> = [];
      raw.lens.on(event => events.push(event as unknown as Record<string, unknown>));

      const response = await fetch(`${raw.baseUrl}/weather`);
      expect(response.status).toBe(402);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.accepts).toBeUndefined();

      // The header is the canonical carrier and events must not depend on it.
      expect(response.headers.get("payment-required")).toBeTruthy();
      expect(events.some(event => event.type === "payment.required")).toBe(true);
    } finally {
      await raw.close();
    }
  });
});

describe("browser buyers", () => {
  it("does not expose payment headers by default", async () => {
    const response = await fetch(`${harness.baseUrl}/weather`);
    expect(response.headers.get("access-control-expose-headers")).toBeNull();
  });

  it("exposes them when cors is enabled", async () => {
    const withCors = await startServer(facilitator.url, { cors: true });
    try {
      const response = await fetch(`${withCors.baseUrl}/weather`);
      const exposed = response.headers.get("access-control-expose-headers") ?? "";
      const allowed = response.headers.get("access-control-allow-headers") ?? "";

      expect(exposed).toContain("PAYMENT-REQUIRED");
      expect(exposed).toContain("PAYMENT-RESPONSE");
      expect(allowed).toContain("PAYMENT-SIGNATURE");
      expect(allowed).toContain("Content-Type");
    } finally {
      await withCors.close();
    }
  });

  it("merges with headers the app already set instead of replacing them", async () => {
    const withCors = await startServer(facilitator.url, { cors: true, ownCors: true });
    try {
      const response = await fetch(`${withCors.baseUrl}/weather`);
      const exposed = response.headers.get("access-control-expose-headers") ?? "";
      expect(exposed).toContain("X-Custom-Header");
      expect(exposed).toContain("PAYMENT-REQUIRED");
    } finally {
      await withCors.close();
    }
  });
});
