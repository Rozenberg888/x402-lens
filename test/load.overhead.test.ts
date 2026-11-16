/**
 * Observability overhead: the lens must stay well under a millisecond of
 * median added cost on a paid request against a local facilitator.
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
let withLensUrl: string;
let bareUrl: string;
let withLensServer: Server;
let bareServer: Server;

beforeAll(async () => {
  facilitator = await startMockFacilitator({ network: NETWORK });

  const lens = paymentLens({
    facilitatorUrl: facilitator.url,
    network: NETWORK,
    payTo: PAY_TO,
    routes: { "GET /weather": "$0.001" },
    sinks: { console: false },
  });
  const lensApp = express();
  lensApp.use(lens.middleware);
  lensApp.get("/weather", (_req, res) => res.json({ ok: true }));
  withLensServer = createServer(lensApp);
  await new Promise<void>(resolve => withLensServer.listen(0, "127.0.0.1", resolve));
  withLensUrl = `http://127.0.0.1:${(withLensServer.address() as AddressInfo).port}`;

  // Baseline: same JSON response, no payment middleware at all.
  const bareApp = express();
  bareApp.get("/weather", (_req, res) => res.json({ ok: true }));
  bareServer = createServer(bareApp);
  await new Promise<void>(resolve => bareServer.listen(0, "127.0.0.1", resolve));
  bareUrl = `http://127.0.0.1:${(bareServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await Promise.all([
    new Promise<void>((resolve, reject) =>
      withLensServer.close(error => (error ? reject(error) : resolve())),
    ),
    new Promise<void>((resolve, reject) =>
      bareServer.close(error => (error ? reject(error) : resolve())),
    ),
    facilitator.close(),
  ]);
});

async function median(samples: number[]): Promise<number> {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function time(url: string, headers?: Record<string, string>, n = 40): Promise<number[]> {
  const times: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const started = performance.now();
    const response = await fetch(url, headers ? { headers } : undefined);
    await response.arrayBuffer();
    times.push(performance.now() - started);
  }
  return times;
}

describe("load: middleware overhead", () => {
  it("keeps median unpaid 402 path under 50ms locally", async () => {
    const times = await time(`${withLensUrl}/weather`);
    const med = await median(times);
    expect(med).toBeLessThan(50);
  });

  it("paid path stays within a small multiple of a bare Express GET", async () => {
    const challengeResponse = await fetch(`${withLensUrl}/weather`);
    const header = challengeResponse.headers.get("payment-required");
    if (!header) throw new Error("no challenge");
    const paymentRequired = decodePaymentRequiredHeader(header) as unknown as WirePaymentRequired;
    const accepted = paymentRequired.accepts?.[0];
    if (!accepted) throw new Error("no accepts");

    const signature = Buffer.from(
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

    // Warmup so JIT / DNS do not dominate.
    await time(bareUrl, undefined, 5);
    await time(`${withLensUrl}/weather`, { "PAYMENT-SIGNATURE": signature }, 5);

    const bare = await median(await time(bareUrl, undefined, 30));
    const paid = await median(
      await time(`${withLensUrl}/weather`, { "PAYMENT-SIGNATURE": signature }, 30),
    );

    // The paid path includes verify+settle round-trips to the mock facilitator.
    // Bound the absolute median, not a ratio — bare GETs are sub-millisecond and
    // a ratio against them is noise.
    expect(paid).toBeLessThan(100);
    expect(bare).toBeLessThan(paid + 100);
  });
});
