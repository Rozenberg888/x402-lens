/**
 * `--json` is the machine interface: CI scripts and agents parse it, so the
 * shape has to stay stable and always include exitCode.
 */

import { afterAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { main } from "../packages/cli/src/index";
import { challenge } from "./fixtures";

async function startPaywall(): Promise<{ url: string; close(): Promise<void> }> {
  const paymentRequired = challenge();
  const server: Server = createServer((_request, response) => {
    response.writeHead(402, {
      "content-type": "application/json",
      "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired as never),
      "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE",
      "Access-Control-Allow-Headers": "Content-Type, PAYMENT-SIGNATURE",
      "Access-Control-Allow-Origin": "*",
    });
    response.end(JSON.stringify(paymentRequired));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/weather`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      }),
  };
}

describe("CLI --json", () => {
  const started: Array<{ close(): Promise<void> }> = [];

  afterAll(async () => {
    await Promise.all(started.map(endpoint => endpoint.close()));
  });

  it("inspect --json emits structured paywall data", async () => {
    const endpoint = await startPaywall();
    started.push(endpoint);

    const chunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    let code: number;
    try {
      code = await main(["inspect", endpoint.url, "--json"]);
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(code).toBe(0);
    const payload = JSON.parse(chunks.join("")) as {
      status: number;
      headerPresent: boolean;
      exitCode: number;
      paymentRequired: { x402Version: number };
      conformance: unknown[];
    };
    expect(payload.status).toBe(402);
    expect(payload.headerPresent).toBe(true);
    expect(payload.exitCode).toBe(0);
    expect(payload.paymentRequired.x402Version).toBe(2);
    expect(payload.conformance).toEqual([]);
  });

  it("explain --json returns findings array", async () => {
    const chunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    let code: number;
    try {
      code = await main([
        "explain",
        "--json",
        "--settle",
        JSON.stringify({
          success: false,
          errorReason: "settlement_pending",
          transaction: "0xdeadbeef",
          network: "eip155:84532",
        }),
      ]);
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(code).toBe(0);
    const payload = JSON.parse(chunks.join("")) as {
      findings: Array<{ code: string }>;
      findingCount: number;
      exitCode: number;
    };
    expect(payload.exitCode).toBe(0);
    expect(payload.findingCount).toBeGreaterThan(0);
    expect(payload.findings.some(finding => finding.code === "settlement_pending")).toBe(true);
  });

  it("reconcile --json reports structured status", async () => {
    const chunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    let code: number;
    try {
      code = await main(["reconcile", "--json", "--tx", "0x1", "--network", "base-sepolia"]);
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(code).toBe(2);
    const payload = JSON.parse(chunks.join("")) as {
      status: string;
      exitCode: number;
      detail: string;
    };
    expect(payload.exitCode).toBe(2);
    expect(payload.status).toBe("unknown");
    expect(payload.detail).toMatch(/CAIP-2|eip155:84532/);
  });
});
