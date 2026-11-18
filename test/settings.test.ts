/**
 * Additional configuration surface: multi-network pricing, facilitator auth,
 * timeouts, per-route metadata, and access grants.
 *
 * Each of these is checked against the real `@x402/express` middleware where it
 * affects the wire, because a setting that is accepted but ignored is worse
 * than one that is rejected.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import {
  ConfigError,
  resolveConfig,
  toRoutesConfig,
  type LensConfig,
  type WirePaymentRequired,
} from "@x402-lens/core";
import { paymentLens, type PaymentLens } from "@x402-lens/express";
import { startMockFacilitator, type MockFacilitator } from "./helpers/mockFacilitator";

const BASE_SEPOLIA = "eip155:84532";
const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const SOL_PAY_TO = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const PAYER = "0x857b06519E91e3A54538791bDAbd0E22373e36b66";

/** One address per network: an address only exists on the chain it belongs to. */
const PAY_TO_BY_NETWORK = { [BASE_SEPOLIA]: PAY_TO, [SOLANA_DEVNET]: SOL_PAY_TO };

const baseEnv = {} as Record<string, string | undefined>;

function configInput(overrides: Record<string, unknown> = {}) {
  return {
    facilitatorUrl: "https://x402.org/facilitator",
    network: BASE_SEPOLIA,
    payTo: PAY_TO,
    routes: [{ route: "GET /weather", price: "0.001" }],
    env: baseEnv,
    ...overrides,
  };
}

describe("multi-network pricing", () => {
  it("keeps a single network for the existing configuration shape", () => {
    const config = resolveConfig(configInput());
    expect(config.network).toBe(BASE_SEPOLIA);
    expect(config.networks).toEqual([BASE_SEPOLIA]);
  });

  it("advertises one accepts entry per network, in declaration order", () => {
    const config = resolveConfig(
      configInput({ networks: [BASE_SEPOLIA, SOLANA_DEVNET], payTo: PAY_TO_BY_NETWORK }),
    );

    expect(config.networks).toEqual([BASE_SEPOLIA, SOLANA_DEVNET]);
    // The primary network stays the first entry, so existing code that reads
    // `config.network` keeps working.
    expect(config.network).toBe(BASE_SEPOLIA);

    const routes = toRoutesConfig(config);
    const accepts = routes["GET /weather"]?.accepts ?? [];
    expect(accepts).toHaveLength(2);
    expect(accepts.map(option => option.network)).toEqual([BASE_SEPOLIA, SOLANA_DEVNET]);
    expect(accepts.every(option => option.price === "$0.001")).toBe(true);
    // Each chain gets a wallet that actually exists on it.
    expect(accepts.map(option => option.payTo)).toEqual([PAY_TO, SOL_PAY_TO]);
  });

  it("reads X402_NETWORKS as a comma-separated list", () => {
    const config = resolveConfig(
      configInput({
        network: undefined,
        networks: undefined,
        payTo: PAY_TO_BY_NETWORK,
        env: { X402_NETWORKS: `${BASE_SEPOLIA}, ${SOLANA_DEVNET}` },
      }),
    );
    expect(config.networks).toEqual([BASE_SEPOLIA, SOLANA_DEVNET]);
  });

  it("prefers networks over the single network when both are given", () => {
    const config = resolveConfig(
      configInput({ network: SOLANA_DEVNET, networks: [BASE_SEPOLIA] }),
    );
    expect(config.networks).toEqual([BASE_SEPOLIA]);
    expect(config.network).toBe(BASE_SEPOLIA);
  });

  it("drops duplicates without reordering", () => {
    const config = resolveConfig(
      configInput({
        networks: [BASE_SEPOLIA, SOLANA_DEVNET, BASE_SEPOLIA],
        payTo: PAY_TO_BY_NETWORK,
      }),
    );
    expect(config.networks).toEqual([BASE_SEPOLIA, SOLANA_DEVNET]);
  });

  it("rejects a shorthand anywhere in the list", () => {
    try {
      resolveConfig(configInput({ networks: [BASE_SEPOLIA, "solana-devnet"] }));
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as ConfigError).message).toContain("EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
    }
  });
});

describe("payment flow", () => {
  it("omits extra when no flow is requested, so the SDK default applies", () => {
    const config = resolveConfig(configInput());
    const accepts = toRoutesConfig(config)["GET /weather"]?.accepts ?? [];
    expect(accepts[0]?.extra).toBeUndefined();
  });

  it("forwards an explicit flow into accepts[].extra", () => {
    // The SDK reads the flow only from extra.paymentFlow, so anything else would
    // be a setting that is accepted and ignored.
    const config = resolveConfig(
      configInput({
        routes: [{ route: "GET /generate", price: "0.05", paymentFlow: "upfront" }],
      }),
    );
    const accepts = toRoutesConfig(config)["GET /generate"]?.accepts ?? [];
    expect(accepts[0]?.extra).toEqual({ paymentFlow: "upfront" });
  });

  it("rejects an unknown flow with the two valid values", () => {
    try {
      resolveConfig(
        configInput({ routes: [{ route: "GET /x", price: "0.01", paymentFlow: "escrow" }] }),
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as ConfigError).message).toContain("authorization");
      expect((error as ConfigError).message).toContain("upfront");
    }
  });

  it("keeps the flow per route rather than global", () => {
    const config = resolveConfig(
      configInput({
        routes: [
          { route: "GET /weather", price: "0.001" },
          { route: "POST /generate", price: "0.05", paymentFlow: "upfront" },
        ],
      }),
    );
    const routes = toRoutesConfig(config);
    expect(routes["GET /weather"]?.accepts[0]?.extra).toBeUndefined();
    expect(routes["POST /generate"]?.accepts[0]?.extra).toEqual({ paymentFlow: "upfront" });
  });
});

describe("receiving addresses per network", () => {
  it("refuses one EVM address for a Solana network", () => {
    // The bug this prevents: the challenge advertised 0x2096… as the recipient
    // on Solana, where no such account can exist. Every Solana payment would
    // have been sent to a wallet nobody controls.
    try {
      resolveConfig(
        configInput({ networks: [BASE_SEPOLIA, SOLANA_DEVNET], payTo: PAY_TO }),
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as ConfigError).field).toBe("payTo");
      expect((error as ConfigError).message).toContain("Solana");
      expect((error as ConfigError).message).toContain("each network its own address");
    }
  });

  it("accepts one address across two EVM chains", () => {
    // Same address format, so sharing is legitimate.
    const config = resolveConfig(
      configInput({
        networks: [BASE_SEPOLIA, "eip155:8453"],
        payTo: PAY_TO,
      }),
    );
    expect(config.payToByNetwork[BASE_SEPOLIA]).toBe(PAY_TO);
    expect(config.payToByNetwork["eip155:8453"]).toBe(PAY_TO);
  });

  it("matches a namespace entry when no network entry exists", () => {
    const config = resolveConfig(
      configInput({
        networks: [BASE_SEPOLIA, SOLANA_DEVNET],
        payTo: { solana: SOL_PAY_TO, [BASE_SEPOLIA]: PAY_TO },
      }),
    );
    expect(config.payToByNetwork[SOLANA_DEVNET]).toBe(SOL_PAY_TO);
  });

  it("falls back to a wildcard address", () => {
    const config = resolveConfig(
      configInput({
        networks: [BASE_SEPOLIA, "eip155:8453"],
        payTo: { "*": PAY_TO },
      }),
    );
    expect(config.payToByNetwork["eip155:8453"]).toBe(PAY_TO);
  });

  it("names the network missing an address", () => {
    try {
      resolveConfig(
        configInput({
          networks: [BASE_SEPOLIA, SOLANA_DEVNET],
          payTo: { [BASE_SEPOLIA]: PAY_TO },
        }),
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as ConfigError).message).toContain(SOLANA_DEVNET);
    }
  });

  it("reads per-network addresses from X402_PAY_TO_<NETWORK>", () => {
    const config = resolveConfig(
      configInput({
        networks: [BASE_SEPOLIA, SOLANA_DEVNET],
        payTo: undefined,
        env: {
          X402_NETWORKS: `${BASE_SEPOLIA},${SOLANA_DEVNET}`,
          X402_PAY_TO: PAY_TO,
          X402_PAY_TO_SOLANA_ETWTRABZAYQ6IMFEYKOURU166VU2XQA1: SOL_PAY_TO,
        },
      }),
    );
    expect(config.payToByNetwork[BASE_SEPOLIA]).toBe(PAY_TO);
    expect(config.payToByNetwork[SOLANA_DEVNET]).toBe(SOL_PAY_TO);
  });
});

describe("asset pricing", () => {
  it("passes an explicit asset price through instead of dollar-pegging it", () => {
    const config = resolveConfig(
      configInput({
        routes: [
          {
            route: "GET /weather",
            price: { asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", amount: "10000" },
          },
        ],
      }),
    );

    const accepts = toRoutesConfig(config)["GET /weather"]?.accepts ?? [];
    expect(accepts[0]?.price).toEqual({
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      amount: "10000",
    });
  });

  it("rejects a decimal amount in an asset price", () => {
    // The SDK converts "$" prices; an explicit asset price is already atomic, so
    // "0.01" would be read as 0.01 atomic units — a 1,000,000x undercharge.
    expect(() =>
      resolveConfig(
        configInput({
          routes: [{ route: "GET /weather", price: { asset: "0x0", amount: "0.01" } }],
        }),
      ),
    ).toThrow(/atomic units/);
  });

  it("rejects an asset price without an asset or amount", () => {
    expect(() =>
      resolveConfig(configInput({ routes: [{ route: "GET /x", price: { amount: "1" } }] })),
    ).toThrow(/no asset/);
    expect(() =>
      resolveConfig(configInput({ routes: [{ route: "GET /x", price: { asset: "0x0" } }] })),
    ).toThrow(/no amount/);
  });

  it("refuses one asset price across several networks", () => {
    // A token address is chain-specific; silently picking one chain would
    // mis-price every buyer on the others.
    try {
      resolveConfig(
        configInput({
          networks: [BASE_SEPOLIA, SOLANA_DEVNET],
          payTo: PAY_TO_BY_NETWORK,
          routes: [{ route: "GET /weather", price: { asset: "0x0", amount: "1" } }],
        }),
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as ConfigError).message).toContain("chain-specific");
      expect((error as ConfigError).message).toContain("$");
    }
  });
});

describe("per-route metadata and timeouts", () => {
  it("carries description, mimeType, tags, and icon into the route config", () => {
    const config = resolveConfig(
      configInput({
        routes: [
          {
            route: "GET /weather",
            price: "0.001",
            description: "Current conditions",
            mimeType: "application/json",
            serviceName: "Weather",
            iconUrl: "https://example.com/icon.png",
            tags: ["weather", "forecast"],
          },
        ],
      }),
    );

    const route = toRoutesConfig(config)["GET /weather"];
    expect(route?.description).toBe("Current conditions");
    expect(route?.mimeType).toBe("application/json");
    expect(route?.serviceName).toBe("Weather");
    expect(route?.iconUrl).toBe("https://example.com/icon.png");
    expect(route?.tags).toEqual(["weather", "forecast"]);
  });

  it("lets a route override the global settlement window", () => {
    const config = resolveConfig(
      configInput({
        maxTimeoutSeconds: 60,
        routes: [
          { route: "GET /slow", price: "0.001", maxTimeoutSeconds: 300 },
          { route: "GET /fast", price: "0.001" },
        ],
      }),
    );

    const routes = toRoutesConfig(config);
    expect(routes["GET /slow"]?.accepts[0]?.maxTimeoutSeconds).toBe(300);
    expect(routes["GET /fast"]?.accepts[0]?.maxTimeoutSeconds).toBe(60);
  });

  it("copies tags so later mutation cannot change config", () => {
    const tags = ["weather"];
    const config = resolveConfig(
      configInput({ routes: [{ route: "GET /weather", price: "0.001", tags }] }),
    );
    tags.push("mutated");

    expect(toRoutesConfig(config)["GET /weather"]?.tags).toEqual(["weather"]);
  });
});

describe("facilitator auth and timeout", () => {
  it("turns X402_FACILITATOR_TOKEN into per-endpoint bearer headers", () => {
    const config = resolveConfig(
      configInput({ env: { X402_FACILITATOR_TOKEN: "secret-token" } }),
    );

    expect(config.facilitatorHeaders).toEqual({
      verify: { Authorization: "Bearer secret-token" },
      settle: { Authorization: "Bearer secret-token" },
      supported: { Authorization: "Bearer secret-token" },
    });
  });

  it("prefers explicit headers over the token", () => {
    const headers = {
      verify: { "x-api-key": "explicit" },
      settle: { "x-api-key": "explicit" },
      supported: { "x-api-key": "explicit" },
    };
    const config = resolveConfig(
      configInput({
        env: { X402_FACILITATOR_TOKEN: "env-token" },
        facilitatorHeaders: headers,
      }),
    );
    expect(config.facilitatorHeaders).toEqual(headers);
  });

  it("reads a positive facilitator timeout from env", () => {
    const config = resolveConfig(
      configInput({ env: { X402_FACILITATOR_TIMEOUT_MS: "5000" } }),
    );
    expect(config.facilitatorTimeoutMs).toBe(5000);
  });

  it("rejects a non-positive facilitator timeout", () => {
    expect(() =>
      resolveConfig(configInput({ facilitatorTimeoutMs: 0 })),
    ).toThrow(/positive integer/);
    expect(() =>
      resolveConfig(configInput({ facilitatorTimeoutMs: -1 })),
    ).toThrow(/positive integer/);
  });

  it("leaves the timeout unset when not configured, so the SDK default applies", () => {
    expect(resolveConfig(configInput()).facilitatorTimeoutMs).toBeUndefined();
  });
});

interface Harness {
  baseUrl: string;
  lens: PaymentLens;
  handlerCalls: { count: number };
  close(): Promise<void>;
}

async function startServer(
  config: LensConfig,
  options: Parameters<typeof paymentLens>[0] = {},
): Promise<Harness> {
  const handlerCalls = { count: 0 };
  const lens = paymentLens({ config, sinks: { console: false }, ...options });

  const app = express();
  app.use(lens.middleware);
  for (const route of config.routes) {
    app.get(route.path, (_req, res) => {
      handlerCalls.count += 1;
      res.json({ weather: "sunny" });
    });
  }

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

describe("multi-network against the real middleware", () => {
  let facilitator: MockFacilitator;
  let harness: Harness;

  beforeAll(async () => {
    // The SDK validates every configured network against `/supported` at
    // startup and exits the process when one is missing, so the mock has to
    // advertise both.
    facilitator = await startMockFacilitator({
      network: BASE_SEPOLIA,
      networks: [BASE_SEPOLIA, SOLANA_DEVNET],
    });
    const config = resolveConfig({
      facilitatorUrl: facilitator.url,
      networks: [BASE_SEPOLIA, SOLANA_DEVNET],
      payTo: PAY_TO_BY_NETWORK,
      routes: [{ route: "GET /weather", price: "0.001" }],
      env: baseEnv,
    });
    harness = await startServer(config);
  });

  afterAll(async () => {
    await harness.close();
    await facilitator.close();
  });

  it("advertises both networks in one challenge", async () => {
    const response = await fetch(`${harness.baseUrl}/weather`);
    expect(response.status).toBe(402);

    const header = response.headers.get("payment-required");
    expect(header).toBeTruthy();
    const challenge = decodePaymentRequiredHeader(header as string) as unknown as WirePaymentRequired;

    expect(challenge.accepts).toHaveLength(2);
    expect(challenge.accepts?.map(entry => entry.network)).toEqual([
      BASE_SEPOLIA,
      SOLANA_DEVNET,
    ]);
    // Each chain resolves its own token, which is the whole point of a dollar
    // price over a hard-coded asset.
    const assets = challenge.accepts?.map(entry => entry.asset) ?? [];
    expect(new Set(assets).size).toBe(2);
    // Same price means the same atomic amount only if decimals match; assert the
    // amounts are atomic rather than assuming equality across chains.
    for (const entry of challenge.accepts ?? []) {
      expect(entry.amount).toMatch(/^\d+$/);
    }
    // The recipient must exist on the chain it is advertised for. This is the
    // bug that shipped before the per-network address existed: one EVM address
    // was reused for the Solana entry.
    expect(challenge.accepts?.[0]?.payTo).toBe(PAY_TO);
    expect(challenge.accepts?.[1]?.payTo).toBe(SOL_PAY_TO);
  });

  it("reports how many offers the challenge carried", async () => {
    const events: Array<Record<string, unknown>> = [];
    const unsubscribe = harness.lens.on(event =>
      events.push(event as unknown as Record<string, unknown>),
    );

    await fetch(`${harness.baseUrl}/weather`);
    unsubscribe();

    const required = events.find(event => event.type === "payment.required");
    expect(required?.offers).toBe(2);
  });
});

describe("payment flow against the real middleware", () => {
  let facilitator: MockFacilitator;

  beforeAll(async () => {
    facilitator = await startMockFacilitator({ network: BASE_SEPOLIA });
  });

  afterAll(async () => {
    await facilitator.close();
  });

  function flowConfig(flow: "authorization" | "upfront"): LensConfig {
    return resolveConfig({
      facilitatorUrl: facilitator.url,
      network: BASE_SEPOLIA,
      payTo: PAY_TO,
      routes: [{ route: "GET /weather", price: "0.001", paymentFlow: flow }],
      env: baseEnv,
    });
  }

  it("settles before the handler runs when the route asks for upfront", async () => {
    // The point of upfront is that a handler which throws still gets charged,
    // because the money moved first. That ordering is what this asserts.
    const harness = await startServer(flowConfig("upfront"));
    try {
      const unpaid = await fetch(`${harness.baseUrl}/weather`);
      const challenge = decodePaymentRequiredHeader(
        unpaid.headers.get("payment-required") as string,
      ) as unknown as WirePaymentRequired;
      const accept = challenge.accepts?.[0];

      expect(accept?.extra?.paymentFlow).toBe("upfront");

      const settleIndexBefore = facilitator.calls.filter(call => call.path === "settle").length;

      const paid = await fetch(`${harness.baseUrl}/weather`, {
        headers: { "PAYMENT-SIGNATURE": encodePayload(challenge) },
      });

      expect(paid.status).toBe(200);
      expect(harness.handlerCalls.count).toBe(1);
      // Exactly one settle, and it happened for a successful request.
      const settleCalls = facilitator.calls.filter(call => call.path === "settle");
      expect(settleCalls.length).toBe(settleIndexBefore + 1);
    } finally {
      await harness.close();
    }
  });

  it("does not call the handler at all when an upfront settle fails", async () => {
    const config = flowConfig("upfront");
    const harness = await startServer(config);
    try {
      const unpaid = await fetch(`${harness.baseUrl}/weather`);
      const challenge = decodePaymentRequiredHeader(
        unpaid.headers.get("payment-required") as string,
      ) as unknown as WirePaymentRequired;

      facilitator.settleResult = {
        success: false,
        errorReason: "insufficient_funds",
        // `transaction` is required by the response schema. Omitting it makes the
        // SDK treat the reply as malformed and answer 502, which is a different
        // failure mode from a well-formed rejection.
        transaction: "",
        network: BASE_SEPOLIA,
        payer: PAYER,
      };

      const paid = await fetch(`${harness.baseUrl}/weather`, {
        headers: { "PAYMENT-SIGNATURE": encodePayload(challenge) },
      });

      // No goods for an unpaid upgrade: this is the whole reason to use upfront.
      expect(paid.status).toBe(402);
      expect(harness.handlerCalls.count).toBe(0);
    } finally {
      facilitator.settleResult = {
        success: true,
        transaction: `0x${"11".repeat(32)}`,
        network: BASE_SEPOLIA,
        payer: PAYER,
      };
      await harness.close();
    }
  });

  /** Encode a fake-but-well-formed EVM exact payload for the challenge. */
  function encodePayload(challenge: WirePaymentRequired): string {
    const accept = challenge.accepts?.[0];
    if (!accept) throw new Error("challenge has no accepts");
    return Buffer.from(
      JSON.stringify({
        x402Version: 2,
        resource: challenge.resource,
        accepted: accept,
        payload: {
          signature: `0x${"ab".repeat(65)}`,
          authorization: {
            from: PAYER,
            to: accept.payTo,
            value: accept.amount,
            validAfter: "0",
            validBefore: "9999999999",
            nonce: `0x${"cd".repeat(32)}`,
          },
        },
      }),
      "utf8",
    ).toString("base64");
  }
});

describe("access grants", () => {
  let facilitator: MockFacilitator;

  beforeAll(async () => {
    facilitator = await startMockFacilitator({ network: BASE_SEPOLIA });
  });

  afterAll(async () => {
    await facilitator.close();
  });

  function baseConfig(): LensConfig {
    return resolveConfig({
      facilitatorUrl: facilitator.url,
      network: BASE_SEPOLIA,
      payTo: PAY_TO,
      routes: [{ route: "GET /weather", price: "0.001" }],
      env: baseEnv,
    });
  }

  it("lets a granted request reach the handler without payment", async () => {
    const harness = await startServer(baseConfig(), {
      grant: request => request.header("x-internal-key") === "let-me-in",
    });

    try {
      const unpaid = await fetch(`${harness.baseUrl}/weather`);
      expect(unpaid.status).toBe(402);
      expect(harness.handlerCalls.count).toBe(0);

      const granted = await fetch(`${harness.baseUrl}/weather`, {
        headers: { "x-internal-key": "let-me-in" },
      });
      expect(granted.status).toBe(200);
      expect(harness.handlerCalls.count).toBe(1);
    } finally {
      await harness.close();
    }
  });

  it("emits access.granted so a bypass is never silent", async () => {
    const harness = await startServer(baseConfig(), { grant: () => true });
    const events: Array<Record<string, unknown>> = [];
    const unsubscribe = harness.lens.on(event =>
      events.push(event as unknown as Record<string, unknown>),
    );

    try {
      await fetch(`${harness.baseUrl}/weather`, { headers: { "x-anything": "1" } });
      unsubscribe();
      expect(events.some(event => event.type === "access.granted")).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("denies with a reason when the callback returns a string", async () => {
    const harness = await startServer(baseConfig(), {
      grant: () => "blocked by policy",
    });
    const events: Array<Record<string, unknown>> = [];
    const unsubscribe = harness.lens.on(event =>
      events.push(event as unknown as Record<string, unknown>),
    );

    try {
      const response = await fetch(`${harness.baseUrl}/weather`);
      unsubscribe();

      expect(response.status).toBe(403);
      expect(harness.handlerCalls.count).toBe(0);

      const denied = events.find(event => event.type === "access.denied");
      expect(denied?.reason).toBe("blocked by policy");
    } finally {
      await harness.close();
    }
  });

  it("continues to the normal payment flow when the callback declines", async () => {
    const harness = await startServer(baseConfig(), { grant: () => undefined });
    try {
      const response = await fetch(`${harness.baseUrl}/weather`);
      expect(response.status).toBe(402);
    } finally {
      await harness.close();
    }
  });

  it("does not intercept anything without a grant callback", async () => {
    const harness = await startServer(baseConfig());
    try {
      const response = await fetch(`${harness.baseUrl}/weather`, {
        headers: { "x-internal-key": "let-me-in" },
      });
      expect(response.status).toBe(402);
    } finally {
      await harness.close();
    }
  });
});
