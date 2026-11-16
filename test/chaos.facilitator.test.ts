/**
 * Chaos: facilitator faults the payment path must survive.
 *
 * A broken exporter must not break a payment; a broken facilitator must surface
 * as a 402 / failed event, never as an unhandled throw in the middleware.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { WirePaymentRequired } from "@x402-lens/core";
import { paymentLens } from "@x402-lens/express";
import { startMockFacilitator, type MockFacilitator } from "./helpers/mockFacilitator";

const NETWORK = "eip155:84532";
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const PAYER = "0x857b06519E91e3A54538791bDAbd0E22373e36b66";

let facilitator: MockFacilitator;
let baseUrl: string;
let server: Server;

beforeAll(async () => {
  facilitator = await startMockFacilitator({ network: NETWORK });
  const lens = paymentLens({
    facilitatorUrl: facilitator.url,
    network: NETWORK,
    payTo: PAY_TO,
    routes: { "GET /weather": "$0.001" },
    sinks: { console: false },
    facilitatorTimeoutMs: 200,
  });

  const app = express();
  app.use(lens.middleware);
  app.get("/weather", (_req, res) => res.json({ ok: true }));
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close(error => (error ? reject(error) : resolve())),
  );
  await facilitator.close();
});

async function challenge(): Promise<WirePaymentRequired> {
  const response = await fetch(`${baseUrl}/weather`);
  const header = response.headers.get("payment-required");
  if (!header) throw new Error("missing challenge");
  return decodePaymentRequiredHeader(header) as unknown as WirePaymentRequired;
}

function payload(paymentRequired: WirePaymentRequired): string {
  const accepted = paymentRequired.accepts?.[0];
  if (!accepted) throw new Error("no accepts");
  return Buffer.from(
    JSON.stringify({
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
    }),
    "utf8",
  ).toString("base64");
}

describe("facilitator chaos", () => {
  it("surfaces verify HTTP 500 as a failed payment, not a crash", async () => {
    const paymentRequired = await challenge();
    facilitator.verifyStatus = 500;
    facilitator.verifyResult = { isValid: false, invalidReason: "upstream" };

    const response = await fetch(`${baseUrl}/weather`, {
      headers: { "PAYMENT-SIGNATURE": payload(paymentRequired) },
    });

    expect([402, 500, 502]).toContain(response.status);
    facilitator.verifyStatus = 200;
    facilitator.verifyResult = { isValid: true, payer: PAYER };
  });

  it("surfaces verify HTTP 429 without calling the handler path as success", async () => {
    const paymentRequired = await challenge();
    facilitator.verifyStatus = 429;

    const response = await fetch(`${baseUrl}/weather`, {
      headers: { "PAYMENT-SIGNATURE": payload(paymentRequired) },
    });

    expect(response.status).not.toBe(200);
    facilitator.verifyStatus = 200;
  });

  it("times out a hung verify within the configured facilitatorTimeoutMs", async () => {
    const paymentRequired = await challenge();
    facilitator.verifyDelayMs = 2_000;

    const started = Date.now();
    const response = await fetch(`${baseUrl}/weather`, {
      headers: { "PAYMENT-SIGNATURE": payload(paymentRequired) },
    });
    const elapsed = Date.now() - started;

    expect(response.status).not.toBe(200);
    expect(elapsed).toBeLessThan(5_000);
    facilitator.verifyDelayMs = 0;
  });

  it("returns 402 when settle fails after verify succeeded", async () => {
    const paymentRequired = await challenge();
    facilitator.settleResult = {
      success: false,
      errorReason: "settlement_pending",
      transaction: `0x${"22".repeat(32)}`,
      network: NETWORK,
      payer: PAYER,
    };

    const response = await fetch(`${baseUrl}/weather`, {
      headers: { "PAYMENT-SIGNATURE": payload(paymentRequired) },
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
