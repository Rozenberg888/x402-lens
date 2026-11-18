/**
 * Negative and edge paths that happy-path suites skip.
 *
 * These pin 0.2.4 claims (empty routesConfig, MIDDLEWARE_ERROR, grant throws,
 * OPTIONS without cors, assertLensConfig branches) so a CHANGELOG line cannot
 * ship without a failing test when the behaviour regresses.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { ConfigError, assertLensConfig, resolveConfig, type LensConfig } from "@x402-lens/core";
import { paymentLens } from "@x402-lens/express";
import { startMockFacilitator, type MockFacilitator } from "./helpers/mockFacilitator";

const NETWORK = "eip155:84532";
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";

describe("edge: empty routesConfig", () => {
  it("throws ConfigError instead of silently unprotecting", () => {
    expect(() =>
      paymentLens({
        facilitatorUrl: "https://x402.org/facilitator",
        network: NETWORK,
        payTo: PAY_TO,
        routes: { "GET /weather": "$0.001" },
        routesConfig: {},
        sinks: { console: false },
      }),
    ).toThrow(ConfigError);
  });
});

describe("edge: middleware unexpected throw", () => {
  let facilitator: MockFacilitator;

  beforeAll(async () => {
    facilitator = await startMockFacilitator({ network: NETWORK });
  });

  afterAll(async () => {
    await facilitator.close();
  });

  it("returns 500 MIDDLEWARE_ERROR not a false facilitator 502", async () => {
    const events: Array<{ type: string; message?: string }> = [];
    const lens = paymentLens({
      facilitatorUrl: facilitator.url,
      network: NETWORK,
      payTo: PAY_TO,
      routes: { "GET /weather": "$0.001" },
      sinks: {
        console: false,
        onEvent: event => events.push(event as { type: string; message?: string }),
      },
    });
    await lens.ready;

    lens.httpServer.requiresPayment = () => {
      throw new Error("adapter exploded");
    };

    const app = express();
    app.use(lens.middleware);
    app.get("/weather", (_req, res) => res.json({ ok: true }));
    const server: Server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/weather`);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "internal_error",
        code: "MIDDLEWARE_ERROR",
      });
      expect(
        events.some(
          event =>
            event.type === "facilitator.error" &&
            String(event.message ?? "").includes("middleware: adapter exploded"),
        ),
      ).toBe(true);
    } finally {
      await lens.close();
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      );
    }
  });
});

describe("edge: OPTIONS without cors", () => {
  it("calls next() and does not answer 204 itself", async () => {
    const lens = paymentLens({
      facilitatorUrl: "http://127.0.0.1:24099",
      network: NETWORK,
      payTo: PAY_TO,
      routes: { "* /weather": "$0.001" },
      facilitatorTimeoutMs: 500,
      sinks: { console: false },
    });

    const app = express();
    app.use(lens.middleware);
    app.options("/weather", (_req, res) => res.status(299).end("app-options"));
    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/weather`, {
        method: "OPTIONS",
      });
      expect(response.status).toBe(299);
      expect(await response.text()).toBe("app-options");
    } finally {
      await lens.close();
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      );
    }
  });
});

describe("edge: grant throws", () => {
  let facilitator: MockFacilitator;

  beforeAll(async () => {
    facilitator = await startMockFacilitator({ network: NETWORK });
  });

  afterAll(async () => {
    await facilitator.close();
  });

  it("denies with stable buyer body and truncates long reasons on the event", async () => {
    const long = `secret-${"x".repeat(300)}`;
    const events: Array<{ type: string; reason?: string }> = [];
    const lens = paymentLens({
      facilitatorUrl: facilitator.url,
      network: NETWORK,
      payTo: PAY_TO,
      routes: { "GET /weather": "$0.001" },
      grant: () => {
        throw new Error(long);
      },
      sinks: {
        console: false,
        onEvent: event => events.push(event as { type: string; reason?: string }),
      },
    });

    const app = express();
    app.use(lens.middleware);
    app.get("/weather", (_req, res) => res.json({ ok: true }));
    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/weather`);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "access_denied" });
      const denied = events.find(event => event.type === "access.denied");
      expect(denied?.reason).toHaveLength(200);
      expect(denied?.reason).not.toContain("x".repeat(250));
    } finally {
      await lens.close();
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      );
    }
  });
});

describe("edge: paymentLens config passthrough", () => {
  it("strips trailing slashes on a pre-built config facilitatorUrl", () => {
    const base = resolveConfig({
      facilitatorUrl: "https://x402.org/facilitator",
      network: NETWORK,
      payTo: PAY_TO,
      routes: [{ route: "GET /weather", price: "0.001" }],
      env: {},
    });
    const lens = paymentLens({
      config: { ...base, facilitatorUrl: "https://x402.org/facilitator///" },
      sinks: { console: false },
    });
    expect(lens.config.facilitatorUrl).toBe("https://x402.org/facilitator");
  });

  it("rejects a non-string non-object route map value with ConfigError", () => {
    expect(() =>
      paymentLens({
        facilitatorUrl: "https://x402.org/facilitator",
        network: NETWORK,
        payTo: PAY_TO,
        routes: { "GET /weather": 12 as unknown as string },
        sinks: { console: false },
      }),
    ).toThrow(ConfigError);
  });
});

describe("edge: assertLensConfig remaining branches", () => {
  function base(): LensConfig {
    return resolveConfig({
      facilitatorUrl: "https://x402.org/facilitator",
      network: NETWORK,
      payTo: PAY_TO,
      routes: [{ route: "GET /weather", price: "0.001" }],
      env: {},
    });
  }

  it("rejects empty facilitatorHeaders object", () => {
    expect(() =>
      resolveConfig({
        facilitatorUrl: "https://x402.org/facilitator",
        network: NETWORK,
        payTo: PAY_TO,
        routes: [{ route: "GET /weather", price: "0.001" }],
        facilitatorHeaders: {},
        env: {},
      }),
    ).toThrow(/facilitatorHeaders/i);
  });

  it("rejects a bad uptoFlow on a pre-built config", () => {
    expect(() =>
      assertLensConfig({
        ...base(),
        routes: [
          {
            method: "GET",
            path: "/weather",
            price: "0.001",
            scheme: "upto",
            uptoFlow: "typo" as never,
          },
        ],
      }),
    ).toThrow(/uptoFlow/i);
  });

  it("rejects asset price with multiple networks on assertLensConfig", () => {
    expect(() =>
      assertLensConfig({
        ...base(),
        networks: [NETWORK, "eip155:8453"],
        payToByNetwork: { [NETWORK]: PAY_TO, "eip155:8453": PAY_TO },
        routes: [
          {
            method: "GET",
            path: "/weather",
            price: { asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", amount: "1000" },
          },
        ],
      }),
    ).toThrow(/networks/i);
  });

  it("rejects empty facilitatorUrl and empty networks", () => {
    expect(() => assertLensConfig({ ...base(), facilitatorUrl: "   " })).toThrow(
      /facilitatorUrl/i,
    );
    expect(() => assertLensConfig({ ...base(), networks: [] })).toThrow(/network/i);
  });
});

describe("edge: repeated dead-facilitator requests", () => {
  it("keeps returning 502 and emits INIT facilitator.error only once", async () => {
    const events: string[] = [];
    const lens = paymentLens({
      facilitatorUrl: "http://127.0.0.1:24099",
      network: NETWORK,
      payTo: PAY_TO,
      routes: { "GET /weather": "$0.001" },
      facilitatorTimeoutMs: 300,
      sinks: {
        console: false,
        onEvent: event => events.push(event.type),
      },
    });

    const app = express();
    app.use(lens.middleware);
    app.get("/weather", (_req, res) => res.json({ ok: true }));
    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}/weather`;

    try {
      const first = await fetch(url);
      const second = await fetch(url);
      expect(first.status).toBe(502);
      expect(second.status).toBe(502);
      expect(events.filter(type => type === "facilitator.error")).toHaveLength(1);
    } finally {
      await lens.close();
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      );
    }
  });
});
