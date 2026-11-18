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

    expect(response.status).not.toBe(200);
    expect([402, 502]).toContain(response.status);
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

  it("emits payment.settle_failed with populated findings on terminal settle failure", async () => {
    const events: Array<{ type: string; findings?: Array<{ code: string }>; reason?: string }> =
      [];
    const localFacilitator = await startMockFacilitator({ network: NETWORK });
    const lens = paymentLens({
      facilitatorUrl: localFacilitator.url,
      network: NETWORK,
      payTo: PAY_TO,
      routes: { "GET /weather": "$0.001" },
      sinks: {
        console: false,
        onEvent: event => {
          events.push(event as { type: string; findings?: Array<{ code: string }>; reason?: string });
        },
      },
    });

    const app = express();
    app.use(lens.middleware);
    app.get("/weather", (_req, res) => res.json({ ok: true }));
    const localServer = createServer(app);
    await new Promise<void>(resolve => localServer.listen(0, "127.0.0.1", resolve));
    const address = localServer.address() as AddressInfo;
    const localBase = `http://127.0.0.1:${address.port}`;

    try {
      const unpaid = await fetch(`${localBase}/weather`);
      const header = unpaid.headers.get("payment-required");
      if (!header) throw new Error("missing challenge");
      const paymentRequired = decodePaymentRequiredHeader(
        header,
      ) as unknown as WirePaymentRequired;

      localFacilitator.settleResult = {
        success: false,
        errorReason: "insufficient_funds",
        transaction: "",
        network: NETWORK,
        payer: PAYER,
      };

      const response = await fetch(`${localBase}/weather`, {
        headers: { "PAYMENT-SIGNATURE": payload(paymentRequired) },
      });
      expect(response.status).toBe(402);

      const settleFailed = events.find(event => event.type === "payment.settle_failed");
      expect(settleFailed).toBeDefined();
      expect(settleFailed?.reason).toBe("insufficient_funds");
      expect(settleFailed?.findings?.map(finding => finding.code)).toContain("settlement_failed");
    } finally {
      await new Promise<void>((resolve, reject) =>
        localServer.close(error => (error ? reject(error) : resolve())),
      );
      await localFacilitator.close();
    }
  });

  it("completes OPTIONS preflight with 204 when cors is enabled", async () => {
    const lens = paymentLens({
      facilitatorUrl: "http://127.0.0.1:24099",
      network: NETWORK,
      payTo: PAY_TO,
      routes: { "* /weather": "$0.001" },
      facilitatorTimeoutMs: 500,
      cors: { origin: "*" },
      sinks: { console: false },
    });

    const app = express();
    app.use(lens.middleware);
    const localServer = createServer(app);
    await new Promise<void>(resolve => localServer.listen(0, "127.0.0.1", resolve));
    const address = localServer.address() as AddressInfo;
    const localBase = `http://127.0.0.1:${address.port}`;

    try {
      const response = await fetch(`${localBase}/weather`, { method: "OPTIONS" });
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(response.headers.get("access-control-allow-headers") ?? "").toContain(
        "PAYMENT-SIGNATURE",
      );
    } finally {
      await lens.close();
      await new Promise<void>((resolve, reject) =>
        localServer.close(error => (error ? reject(error) : resolve())),
      );
    }
  });

  it("lets unprotected routes through when the facilitator is unreachable", async () => {
    const lens = paymentLens({
      facilitatorUrl: "http://127.0.0.1:24099",
      network: NETWORK,
      payTo: PAY_TO,
      routes: { "GET /weather": "$0.001" },
      facilitatorTimeoutMs: 500,
      sinks: { console: false },
    });

    const app = express();
    app.use(lens.middleware);
    app.get("/health", (_req, res) => res.json({ ok: true }));
    app.get("/weather", (_req, res) => res.json({ ok: true }));
    const localServer = createServer(app);
    await new Promise<void>(resolve => localServer.listen(0, "127.0.0.1", resolve));
    const address = localServer.address() as AddressInfo;
    const localBase = `http://127.0.0.1:${address.port}`;

    try {
      const health = await fetch(`${localBase}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });

      const paid = await fetch(`${localBase}/weather`);
      expect(paid.status).toBe(502);
    } finally {
      await lens.close();
      await new Promise<void>((resolve, reject) =>
        localServer.close(error => (error ? reject(error) : resolve())),
      );
    }
  });

  it("honours grant bypass when the facilitator is unreachable", async () => {
    const events: string[] = [];
    const lens = paymentLens({
      facilitatorUrl: "http://127.0.0.1:24099",
      network: NETWORK,
      payTo: PAY_TO,
      routes: { "GET /weather": "$0.001" },
      facilitatorTimeoutMs: 500,
      grant: request => request.header("x-internal") === "1",
      sinks: {
        console: false,
        onEvent: event => events.push(event.type),
      },
    });

    const app = express();
    app.use(lens.middleware);
    app.get("/weather", (_req, res) => res.json({ ok: true }));
    const localServer = createServer(app);
    await new Promise<void>(resolve => localServer.listen(0, "127.0.0.1", resolve));
    const address = localServer.address() as AddressInfo;
    const localBase = `http://127.0.0.1:${address.port}`;

    try {
      const allowed = await fetch(`${localBase}/weather`, {
        headers: { "x-internal": "1" },
      });
      expect(allowed.status).toBe(200);
      expect(events).toContain("access.granted");

      const blocked = await fetch(`${localBase}/weather`);
      expect(blocked.status).toBe(502);
    } finally {
      await lens.close();
      await new Promise<void>((resolve, reject) =>
        localServer.close(error => (error ? reject(error) : resolve())),
      );
    }
  });

  it("returns 502 with facilitator.error when the facilitator is unreachable", async () => {
    const events: Array<{ type: string; message?: string }> = [];
    const lens = paymentLens({
      facilitatorUrl: "http://127.0.0.1:24099",
      network: NETWORK,
      payTo: PAY_TO,
      routes: { "GET /weather": "$0.001" },
      facilitatorTimeoutMs: 500,
      sinks: {
        console: false,
        onEvent: event => {
          events.push(event as { type: string; message?: string });
        },
      },
    });

    const app = express();
    app.use(lens.middleware);
    app.get("/weather", (_req, res) => res.json({ ok: true }));
    const localServer = createServer(app);
    await new Promise<void>(resolve => localServer.listen(0, "127.0.0.1", resolve));
    const address = localServer.address() as AddressInfo;
    const localBase = `http://127.0.0.1:${address.port}`;

    try {
      await expect(lens.ready).rejects.toThrow(/no supported payment kinds/i);

      const response = await fetch(`${localBase}/weather`);
      expect(response.status).toBe(502);
      const body = (await response.json()) as { error?: string; code?: string };
      expect(body).toEqual({
        error: "facilitator_unavailable",
        code: "FACILITATOR_UNAVAILABLE",
      });
      const initError = events.find(event => event.type === "facilitator.error");
      expect(initError).toBeDefined();
      expect(initError?.message).toMatch(/no supported payment kinds/i);
    } finally {
      await lens.close();
      await new Promise<void>((resolve, reject) =>
        localServer.close(error => (error ? reject(error) : resolve())),
      );
    }
  });

  it("emits settlement_pending finding on non-terminal settle failure", async () => {
    const events: Array<{ type: string; findings?: Array<{ code: string }> }> = [];
    const localFacilitator = await startMockFacilitator({ network: NETWORK });
    const lens = paymentLens({
      facilitatorUrl: localFacilitator.url,
      network: NETWORK,
      payTo: PAY_TO,
      routes: { "GET /weather": "$0.001" },
      sinks: {
        console: false,
        onEvent: event => {
          events.push(event as { type: string; findings?: Array<{ code: string }> });
        },
      },
    });

    const app = express();
    app.use(lens.middleware);
    app.get("/weather", (_req, res) => res.json({ ok: true }));
    const localServer = createServer(app);
    await new Promise<void>(resolve => localServer.listen(0, "127.0.0.1", resolve));
    const address = localServer.address() as AddressInfo;
    const localBase = `http://127.0.0.1:${address.port}`;

    try {
      const unpaid = await fetch(`${localBase}/weather`);
      const header = unpaid.headers.get("payment-required");
      if (!header) throw new Error("missing challenge");
      const paymentRequired = decodePaymentRequiredHeader(
        header,
      ) as unknown as WirePaymentRequired;

      localFacilitator.settleResult = {
        success: false,
        errorReason: "settlement_pending",
        transaction: `0x${"22".repeat(32)}`,
        network: NETWORK,
        payer: PAYER,
      };

      const response = await fetch(`${localBase}/weather`, {
        headers: { "PAYMENT-SIGNATURE": payload(paymentRequired) },
      });
      expect(response.status).toBe(402);

      const settleFailed = events.find(event => event.type === "payment.settle_failed");
      expect(settleFailed?.findings?.map(finding => finding.code)).toContain("settlement_pending");
    } finally {
      await new Promise<void>((resolve, reject) =>
        localServer.close(error => (error ? reject(error) : resolve())),
      );
      await localFacilitator.close();
    }
  });
});
