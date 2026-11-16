/**
 * `upto` scheme support, verified against the real middleware.
 *
 * Two things must hold. A valid `upto` route must produce a challenge carrying
 * `scheme: "upto"` and the flow the scheme requires. An invalid combination must
 * be refused by config resolution — because if it reaches the SDK, `@x402/core`
 * turns it into a `RouteConfigurationError` and calls `process.exit(1)` from its
 * background init, so the process dies without ever answering a request.
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
  type ResolveConfigInput,
  type WirePaymentRequired,
} from "@x402-lens/core";
import { paymentLens } from "@x402-lens/express";
import { startMockFacilitator, type MockFacilitator } from "./helpers/mockFacilitator";

const EVM = "eip155:84532";
const SVM = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const ADDRESS = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const SOL_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const PAY_TO = { [EVM]: ADDRESS, [SVM]: SOL_ADDRESS };

/** Minimal config input for one route. */
function input(
  route: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): ResolveConfigInput {
  return {
    facilitatorUrl: "https://x402.org/facilitator",
    network: EVM,
    payTo: ADDRESS,
    routes: [route],
    env: {} as Record<string, string | undefined>,
    ...overrides,
  } as ResolveConfigInput;
}

describe("upto scheme configuration", () => {
  it("defaults the scheme to exact, so existing routes are unchanged", () => {
    const config = resolveConfig(input({ route: "GET /weather", price: "0.001" }));
    const accepts = toRoutesConfig(config)["GET /weather"]?.accepts ?? [];
    expect(accepts[0]?.scheme).toBe("exact");
    expect(accepts[0]?.extra).toBeUndefined();
  });

  it("advertises upto with the flow EVM requires", () => {
    const config = resolveConfig(
      input({ route: "POST /generate", price: "0.05", scheme: "upto" }),
    );
    const accepts = toRoutesConfig(config)["POST /generate"]?.accepts ?? [];
    expect(accepts[0]?.scheme).toBe("upto");
    // EVM upto supports only authorization; anything else is fatal at startup.
    expect(accepts[0]?.extra).toEqual({ paymentFlow: "authorization" });
  });

  it("advertises upto with escrow on Solana", () => {
    const config = resolveConfig(
      input(
        { route: "POST /generate", price: "0.05", scheme: "upto" },
        { network: SVM, payTo: SOL_ADDRESS },
      ),
    );
    const accepts = toRoutesConfig(config)["POST /generate"]?.accepts ?? [];
    expect(accepts[0]?.extra).toEqual({ paymentFlow: "escrow" });
  });

  it("honours an explicit uptoFlow where the scheme allows it", () => {
    const config = resolveConfig(
      input({ route: "POST /x", price: "0.05", scheme: "upto", uptoFlow: "escrow" }, {
        network: SVM,
        payTo: SOL_ADDRESS,
      }),
    );
    expect(toRoutesConfig(config)["POST /x"]?.accepts[0]?.extra).toEqual({
      paymentFlow: "escrow",
    });
  });

  it("refuses authorization on Solana upto, naming the valid flow", () => {
    // Left to the SDK this would exit the process; catching it here means the
    // operator sees a route name and a reason instead of a server that vanished.
    try {
      resolveConfig(
        input(
          { route: "POST /x", price: "0.05", scheme: "upto", uptoFlow: "authorization" },
          { network: SVM, payTo: SOL_ADDRESS },
        ),
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toContain("escrow");
      expect((error as ConfigError).message).toContain("POST /x");
    }
  });

  it("refuses paymentFlow alongside upto, which fixes the flow itself", () => {
    try {
      resolveConfig(
        input({ route: "POST /x", price: "0.05", scheme: "upto", paymentFlow: "upfront" }),
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as ConfigError).message).toContain("remove paymentFlow");
    }
  });

  it("rejects an unknown scheme with the two registered ones", () => {
    try {
      resolveConfig(input({ route: "GET /x", price: "0.1", scheme: "batch-settlement" }));
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as ConfigError).message).toContain("exact");
      expect((error as ConfigError).message).toContain("upto");
    }
  });

  it("allows different schemes on different routes", () => {
    const config = resolveConfig({
      facilitatorUrl: "https://x402.org/facilitator",
      network: EVM,
      payTo: ADDRESS,
      routes: [
        { route: "GET /weather", price: "0.001" },
        { route: "POST /generate", price: "0.05", scheme: "upto" },
      ],
      env: {},
    });
    const routes = toRoutesConfig(config);
    expect(routes["GET /weather"]?.accepts[0]?.scheme).toBe("exact");
    expect(routes["POST /generate"]?.accepts[0]?.scheme).toBe("upto");
  });
});

interface Harness {
  baseUrl: string;
  close(): Promise<void>;
}

/**
 * Start a server for one config and return its base URL.
 *
 * @param config - Resolved config
 * @returns Harness with a closer
 */
async function startServer(config: LensConfig): Promise<Harness> {
  const lens = paymentLens({ config, sinks: { console: false } });
  const app = express();
  app.use(lens.middleware);
  for (const route of config.routes) {
    app[route.method === "POST" ? "post" : "get"](route.path, (_req, res) => res.json({ ok: true }));
  }

  const server: Server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      }),
  };
}

describe("upto against the real middleware", () => {
  let facilitator: MockFacilitator;

  beforeAll(async () => {
    // The SDK validates every configured network against /supported at startup,
    // and every scheme too, so the mock has to advertise upto.
    facilitator = await startMockFacilitator({ network: EVM, schemes: ["exact", "upto"] });
  });

  afterAll(async () => {
    await facilitator.close();
  });

  it("issues a challenge with scheme upto and the required flow", async () => {
    const config = resolveConfig(
      input(
        { route: "POST /generate", price: "0.05", scheme: "upto" },
        { facilitatorUrl: facilitator.url },
      ),
    );
    const harness = await startServer(config);

    try {
      const response = await fetch(`${harness.baseUrl}/generate`, { method: "POST" });
      expect(response.status).toBe(402);

      const header = response.headers.get("payment-required");
      const challenge = decodePaymentRequiredHeader(header as string) as unknown as WirePaymentRequired;
      const accept = challenge.accepts?.[0];

      expect(accept?.scheme).toBe("upto");
      expect(accept?.network).toBe(EVM);
      expect(accept?.amount).toMatch(/^\d+$/);
      expect(accept?.extra?.paymentFlow).toBe("authorization");
      // permit2 is the transfer method upto uses on EVM; seeing a different one
      // would mean the scheme was not the one registered.
      expect(accept?.extra?.assetTransferMethod).toBe("permit2");
    } finally {
      await harness.close();
    }
  });

  it("keeps an exact route byte-identical when upto is also present", async () => {
    const config = resolveConfig({
      facilitatorUrl: facilitator.url,
      network: EVM,
      payTo: ADDRESS,
      routes: [
        { route: "GET /weather", price: "0.001" },
        { route: "POST /generate", price: "0.05", scheme: "upto" },
      ],
      env: {},
    });
    const harness = await startServer(config);

    try {
      const response = await fetch(`${harness.baseUrl}/weather`);
      const challenge = decodePaymentRequiredHeader(
        response.headers.get("payment-required") as string,
      ) as unknown as WirePaymentRequired;
      expect(challenge.accepts?.[0]?.scheme).toBe("exact");
      expect(challenge.accepts?.[0]?.extra?.paymentFlow).toBeUndefined();
    } finally {
      await harness.close();
    }
  });
});
