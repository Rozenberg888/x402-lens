/**
 * `inspect` and `doctor`, driven against real HTTP servers.
 *
 * Both commands exist to fail a build, so the assertions are mostly about exit
 * codes: a false pass here lets a broken paywall reach production.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import type { WirePaymentRequired } from "@x402-lens/core";
import { inspectEndpoint } from "../packages/cli/src/commands/inspect";
import { runDoctor } from "../packages/cli/src/commands/doctor";
import { startMockFacilitator, type MockFacilitator } from "./helpers/mockFacilitator";
import { PAY_TO, USDC_BASE_SEPOLIA, challenge } from "./fixtures";

const NETWORK = "eip155:84532";

interface Endpoint {
  url: string;
  close(): Promise<void>;
}

/**
 * Serve one 402 with configurable headers and body.
 *
 * @param options - Challenge to advertise, CORS headers, and body shape
 * @returns The endpoint URL and a closer
 */
async function startEndpoint(options: {
  paymentRequired?: WirePaymentRequired;
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  omitHeader?: boolean;
}): Promise<Endpoint> {
  const server: Server = createServer((request, response) => {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.paymentRequired && !options.omitHeader) {
      headers["PAYMENT-REQUIRED"] = encodePaymentRequiredHeader(
        options.paymentRequired as never,
      );
    }
    headers["content-type"] = "application/json";
    const status = options.status ?? (options.paymentRequired ? 402 : 200);
    const body =
      options.body ??
      (options.paymentRequired ? { x402Version: 2, accepts: [] } : { ok: true });
    response.writeHead(status, headers);
    response.end(JSON.stringify(body));
    void request;
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

describe("inspect", () => {
  const started: Endpoint[] = [];

  afterAll(async () => {
    await Promise.all(started.map(endpoint => endpoint.close()));
  });

  async function endpoint(options: Parameters<typeof startEndpoint>[0]): Promise<string> {
    const created = await startEndpoint(options);
    started.push(created);
    return created.url;
  }

  it("passes a conformant paywall with correct CORS", async () => {
    const url = await endpoint({
      paymentRequired: challenge(),
      headers: {
        "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE",
        "Access-Control-Allow-Headers": "Content-Type, PAYMENT-SIGNATURE",
        "Access-Control-Allow-Origin": "*",
      },
    });

    const result = await inspectEndpoint({ url });

    expect(result.status).toBe(402);
    expect(result.headerPresent).toBe(true);
    expect(result.conformance).toEqual([]);
    expect(result.cors.issues).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.findings).toContain("x402Version: 2");
  });

  it("does not follow redirects that would hide a 402 paywall", async () => {
    const paywall = await endpoint({
      paymentRequired: challenge(),
      headers: {
        "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE",
        "Access-Control-Allow-Headers": "Content-Type, PAYMENT-SIGNATURE",
        "Access-Control-Allow-Origin": "*",
      },
    });
    const redirect = await startEndpoint({
      status: 302,
      headers: { Location: paywall },
      body: { redirected: true },
    });
    started.push(redirect);

    const result = await inspectEndpoint({ url: redirect.url });

    expect(result.status).toBe(302);
    expect(result.paymentRequired).toBeUndefined();
    expect(result.exitCode).toBe(1);
    expect(result.findings).toMatch(/Redirected \(HTTP 302\)/);
  });

  it("fails when the challenge is not exposed to browsers", async () => {
    // The default, most common mistake: a working paywall that no browser can
    // buy from.
    const url = await endpoint({ paymentRequired: challenge() });
    const result = await inspectEndpoint({ url });

    expect(result.cors.issues.length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(1);
    expect(result.findings).toContain("Browser (CORS)");
  });

  it("fails when the route is not protected at all", async () => {
    const url = await endpoint({});
    const result = await inspectEndpoint({ url });

    expect(result.status).toBe(200);
    expect(result.paymentRequired).toBeUndefined();
    expect(result.exitCode).toBe(1);
    expect(result.findings).toContain("No x402 challenge found");
  });

  it("reports a non-conformant challenge and still decodes it", async () => {
    const broken: WirePaymentRequired = {
      ...challenge(),
      x402Version: 1,
    };
    const url = await endpoint({
      paymentRequired: broken,
      headers: {
        "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE",
        "Access-Control-Allow-Headers": "Content-Type, PAYMENT-SIGNATURE",
        "Access-Control-Allow-Origin": "*",
      },
    });

    const result = await inspectEndpoint({ url });

    expect(result.conformance.some(issue => issue.field === "x402Version")).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.findings).toContain("Schema conformance");
  });

  it("falls back to a mirrored body when the header is absent", async () => {
    const url = await endpoint({
      paymentRequired: challenge(),
      omitHeader: true,
      headers: {
        "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE",
        "Access-Control-Allow-Headers": "Content-Type, PAYMENT-SIGNATURE",
        "Access-Control-Allow-Origin": "*",
      },
    });

    const result = await inspectEndpoint({ url });

    expect(result.headerPresent).toBe(false);
    expect(result.decodedFromBody).toBe(true);
    expect(result.findings).toContain("response body (no PAYMENT-REQUIRED header)");
  });

  it("describes every accept entry so multi-network pricing is visible", async () => {
    const url = await endpoint({
      paymentRequired: challenge({
        accepts: [
          {
            scheme: "exact",
            network: NETWORK,
            amount: "10000",
            asset: USDC_BASE_SEPOLIA,
            payTo: PAY_TO,
            maxTimeoutSeconds: 60,
          },
          {
            scheme: "exact",
            network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
            amount: "20000",
            asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            payTo: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
            maxTimeoutSeconds: 60,
          },
        ],
      }),
      headers: {
        "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE",
        "Access-Control-Allow-Headers": "Content-Type, PAYMENT-SIGNATURE",
      },
    });

    const result = await inspectEndpoint({ url });

    expect(result.findings).toContain("accepts:     2");
    expect(result.findings).toContain("Solana devnet");
    expect(result.findings).toContain("Base Sepolia");
  });
});

describe("doctor", () => {
  let facilitator: MockFacilitator;

  beforeAll(async () => {
    facilitator = await startMockFacilitator({ network: NETWORK });
  });

  afterAll(async () => {
    await facilitator.close();
  });

  it("passes when the facilitator lists the configured network for v2", async () => {
    const result = await runDoctor({ facilitatorUrl: facilitator.url, network: NETWORK });

    expect(result.exitCode).toBe(0);
    expect(result.text).toContain("exact scheme: The facilitator supports");
  });

  it("checks configured route schemes rather than always assuming exact", async () => {
    const withUpto = await startMockFacilitator({
      network: NETWORK,
      schemes: ["upto"],
    });
    try {
      const result = await runDoctor({
        facilitatorUrl: withUpto.url,
        network: NETWORK,
        config: {
          facilitatorUrl: withUpto.url,
          network: NETWORK,
          networks: [NETWORK],
          payTo: PAY_TO,
          payToByNetwork: { [NETWORK]: PAY_TO },
          routes: [
            {
              method: "GET",
              path: "/metered",
              price: "0.001",
              scheme: "upto",
            },
          ],
          maxTimeoutSeconds: 60,
        },
      });
      expect(result.exitCode).toBe(0);
      expect(result.text).toContain("upto scheme: The facilitator supports");
      expect(result.text).not.toContain("exact scheme:");
    } finally {
      await withUpto.close();
    }
  });

  it("fails when a secondary network lacks a required scheme", async () => {
    const dual = await startMockFacilitator({
      network: NETWORK,
      networks: [NETWORK, "eip155:8453"],
      schemes: ["exact"],
    });
    try {
      const result = await runDoctor({
        facilitatorUrl: dual.url,
        networks: [NETWORK, "eip155:8453"],
        config: {
          facilitatorUrl: dual.url,
          network: NETWORK,
          networks: [NETWORK, "eip155:8453"],
          payTo: PAY_TO,
          payToByNetwork: { [NETWORK]: PAY_TO, "eip155:8453": PAY_TO },
          routes: [
            { method: "GET", path: "/metered", price: "0.001", scheme: "upto" },
          ],
          maxTimeoutSeconds: 60,
        },
      });
      expect(result.exitCode).toBe(1);
      expect(result.text).toMatch(/upto scheme[\s\S]*not listed/);
    } finally {
      await dual.close();
    }
  });

  it("fails when the facilitator does not list the network", async () => {
    const result = await runDoctor({
      facilitatorUrl: facilitator.url,
      network: "eip155:8453",
    });

    expect(result.exitCode).toBe(1);
    expect(result.text).toContain("does not list eip155:8453");
    // The available networks are listed, so the fix is a copy-paste away.
    expect(result.text).toContain(NETWORK);
  });

  it("rejects a v1 shorthand before probing anything", async () => {
    const result = await runDoctor({
      facilitatorUrl: facilitator.url,
      network: "base-sepolia",
    });

    expect(result.exitCode).toBe(1);
    expect(result.text).toContain("not CAIP-2");
    expect(result.text).toContain("eip155:84532");
  });

  it("fails loudly when the facilitator is unreachable", async () => {
    const result = await runDoctor({
      // Port 1 is reserved and refuses connections immediately on every OS.
      facilitatorUrl: "http://127.0.0.1:1",
      network: NETWORK,
      timeoutMs: 2_000,
    });

    expect(result.exitCode).toBe(1);
    expect(result.text).toContain("Could not reach");
  });

  it("fails when /supported returns an error status", async () => {
    const broken = await startMockFacilitator({ network: NETWORK, failSupported: true });
    try {
      const result = await runDoctor({ facilitatorUrl: broken.url, network: NETWORK });
      expect(result.exitCode).toBe(1);
      expect(result.text).toContain("HTTP 500");
    } finally {
      await broken.close();
    }
  });

  it("fails when one of several configured networks is unsupported", async () => {
    // The SDK exits the process when any configured network is missing from
    // /supported, so doctor has to catch this before a deploy rather than let
    // the server die on its first request.
    const result = await runDoctor({
      facilitatorUrl: facilitator.url,
      networks: [NETWORK, "eip155:1"],
    });

    expect(result.exitCode).toBe(1);
    expect(result.text).toContain("all networks supported");
    expect(result.text).toContain("eip155:1");
    expect(result.text).toContain("exits the process");
  });

  it("passes the all-networks check when every network is supported", async () => {
    const result = await runDoctor({
      facilitatorUrl: facilitator.url,
      networks: [NETWORK],
    });

    // A single network needs no aggregate check: the per-network one covers it.
    expect(result.exitCode).toBe(0);
    expect(result.text).not.toContain("all networks supported");
  });

  it("checks the payTo shape for the configured namespace", async () => {
    const result = await runDoctor({
      facilitatorUrl: facilitator.url,
      network: NETWORK,
      config: {
        facilitatorUrl: facilitator.url,
        network: NETWORK,
        networks: [NETWORK],
        payTo: "not-an-address",
        payToByNetwork: { [NETWORK]: "not-an-address" },
        routes: [{ method: "GET", path: "/weather", price: "0.001" }],
        maxTimeoutSeconds: 60,
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.text).toContain("payTo address");
    expect(result.text).toContain("not a 0x-prefixed 20-byte address");

    const valid = await runDoctor({
      facilitatorUrl: facilitator.url,
      network: NETWORK,
      config: {
        facilitatorUrl: facilitator.url,
        network: NETWORK,
        networks: [NETWORK],
        payTo: PAY_TO,
        payToByNetwork: { [NETWORK]: PAY_TO },
        routes: [{ method: "GET", path: "/weather", price: "0.001" }],
        maxTimeoutSeconds: 60,
      },
    });
    expect(valid.exitCode).toBe(0);
    expect(valid.text).toContain("looks like an EVM address");
    expect(valid.text).toContain("facilitatorHeaders");
  });

  it("checks every payToByNetwork entry", async () => {
    const result = await runDoctor({
      facilitatorUrl: facilitator.url,
      networks: [NETWORK, "eip155:8453"],
      config: {
        facilitatorUrl: facilitator.url,
        network: NETWORK,
        networks: [NETWORK, "eip155:8453"],
        payTo: PAY_TO,
        payToByNetwork: {
          [NETWORK]: PAY_TO,
          "eip155:8453": "not-an-address",
        },
        routes: [{ method: "GET", path: "/weather", price: "0.001" }],
        maxTimeoutSeconds: 60,
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.checks.filter(check => check.name === "payTo address").length).toBe(2);
    expect(result.text).toContain("not a 0x-prefixed 20-byte address");
  });

  it("probes /supported with facilitator auth headers from config", async () => {
    const authed = await startMockFacilitator({
      network: NETWORK,
      requireSupportedAuthorization: "Bearer doctor-token",
    });
    try {
      const denied = await runDoctor({
        facilitatorUrl: authed.url,
        network: NETWORK,
        config: {
          facilitatorUrl: authed.url,
          network: NETWORK,
          networks: [NETWORK],
          payTo: PAY_TO,
          payToByNetwork: { [NETWORK]: PAY_TO },
          routes: [{ method: "GET", path: "/weather", price: "0.001" }],
          maxTimeoutSeconds: 60,
        },
      });
      expect(denied.exitCode).toBe(1);
      expect(denied.text).toContain("HTTP 401");

      const allowed = await runDoctor({
        facilitatorUrl: authed.url,
        network: NETWORK,
        config: {
          facilitatorUrl: authed.url,
          network: NETWORK,
          networks: [NETWORK],
          payTo: PAY_TO,
          payToByNetwork: { [NETWORK]: PAY_TO },
          routes: [{ method: "GET", path: "/weather", price: "0.001" }],
          maxTimeoutSeconds: 60,
          facilitatorHeaders: {
            verify: { Authorization: "Bearer doctor-token" },
            settle: { Authorization: "Bearer doctor-token" },
            supported: { Authorization: "Bearer doctor-token" },
          },
        },
      });
      expect(allowed.exitCode).toBe(0);
      const supportedCalls = authed.calls.filter(call => call.path === "supported");
      expect(supportedCalls.some(call => call.headers.authorization === "Bearer doctor-token")).toBe(
        true,
      );
    } finally {
      await authed.close();
    }
  });

  const doctorDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(
      doctorDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })),
    );
  });

  async function doctorConfigDir(body: Record<string, unknown>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "x402-lens-doctor-"));
    doctorDirs.push(dir);
    await writeFile(join(dir, "x402.config.json"), `${JSON.stringify(body, null, 2)}\n`, "utf8");
    return dir;
  }

  it("fails with a facilitatorHeaders check when the config file has a flat object", async () => {
    const cwd = await doctorConfigDir({
      facilitatorUrl: facilitator.url,
      network: NETWORK,
      payTo: PAY_TO,
      routes: [{ route: "GET /weather", price: "0.001" }],
      facilitatorHeaders: { Authorization: "Bearer flat-token" },
    });

    const result = await runDoctor({
      cwd,
      // Overrides must not mask the headers failure.
      facilitatorUrl: facilitator.url,
      network: NETWORK,
    });

    expect(result.exitCode).toBe(1);
    const headersCheck = result.checks.find(check => check.name === "facilitatorHeaders");
    expect(headersCheck?.ok).toBe(false);
    expect(headersCheck?.detail).toMatch(/keyed by facilitator path|must not be set in x402\.config\.json/i);
  });

  it("fails with a facilitatorHeaders check when secrets are in x402.config.json", async () => {
    const cwd = await doctorConfigDir({
      facilitatorUrl: facilitator.url,
      network: NETWORK,
      payTo: PAY_TO,
      routes: [{ route: "GET /weather", price: "0.001" }],
      facilitatorHeaders: {
        verify: { Authorization: "Bearer secret" },
        settle: { Authorization: "Bearer secret" },
        supported: { Authorization: "Bearer secret" },
      },
    });

    const result = await runDoctor({ cwd });
    expect(result.exitCode).toBe(1);
    const headersCheck = result.checks.find(check => check.name === "facilitatorHeaders");
    expect(headersCheck?.ok).toBe(false);
    expect(headersCheck?.detail).toMatch(/must not be set in x402\.config\.json/i);
  });
});
