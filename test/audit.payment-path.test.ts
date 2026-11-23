/**
 * Payment-path defects from the second audit round, pinned.
 *
 * The three critical ones were all "the lens protects nothing and says nothing":
 * a sub-app that answered 200 with its data, a route whose method was a typo, and
 * a receiving address that went to the wrong wallet. None of them produced an
 * error anywhere, which is why each needed reproducing rather than reading.
 */

import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { createAdaptorServer } from "@hono/node-server";
import express from "express";
import { ConfigError, resolveConfig } from "@x402-lens/core";
import { paymentLens as honoLens } from "@x402-lens/hono";
import { paymentLens as expressLens } from "@x402-lens/express";
import { buildServers } from "@x402-lens/server";
import { startMockFacilitator } from "./helpers/mockFacilitator.js";

const EVM = "eip155:84532";
const EVM_OTHER = "eip155:8453";
const SVM = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const SVM_PAY_TO = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

const BASE = { facilitatorUrl: "https://facilitator.example.com", payTo: PAY_TO };

describe("audit: a route method must be an HTTP method", () => {
  it("rejects a typo'd method instead of building a route that never matches", () => {
    // `POX /weather` was uppercased and accepted, so the route key never matched
    // a request: the handler ran unpaid, no 402, no event, no error.
    expect(() => resolveConfig({ ...BASE, network: EVM, routes: { "POX /weather": "0.001" } })).toThrow(
      ConfigError,
    );
  });

  it("names the known methods in the message", () => {
    expect(() =>
      resolveConfig({ ...BASE, network: EVM, routes: { "POX /weather": "0.001" } }),
    ).toThrow(/GET, POST/);
  });

  it("accepts every method the adapters honour", () => {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "*"]) {
      expect(
        () => resolveConfig({ ...BASE, network: EVM, routes: { [`${method} /x`]: "0.001" } }),
        `method ${method} should be accepted`,
      ).not.toThrow();
    }
  });

  it("accepts a lowercase method by normalising it", () => {
    const config = resolveConfig({ ...BASE, network: EVM, routes: { "get /x": "0.001" } });
    expect(config.routes[0]?.method).toBe("GET");
  });
});

describe("audit: per-network receiving addresses", () => {
  it("uses X402_PAY_TO_<network> when networks come from the environment", () => {
    const config = resolveConfig({
      facilitatorUrl: "https://facilitator.example.com",
      routes: { "GET /w": "0.001" },
      env: {
        X402_NETWORKS: `${EVM},${SVM}`,
        X402_PAY_TO: PAY_TO,
        X402_PAY_TO_SOLANA_ETWTRABZAYQ6IMFEYKOURU166VU2XQA1: SVM_PAY_TO,
      },
    });

    expect(config.payToByNetwork[EVM]).toBe(PAY_TO);
    expect(config.payToByNetwork[SVM]).toBe(SVM_PAY_TO);
  });

  it("uses X402_PAY_TO_<network> when networks are listed in code", () => {
    // The resolver used to read the *environment's* network list, so with
    // `networks` in code the per-network variable matched nothing and the shared
    // address was used for every chain — payments to the wrong wallet, no error.
    const config = resolveConfig({
      facilitatorUrl: "https://facilitator.example.com",
      networks: [EVM_OTHER, EVM],
      routes: { "GET /w": "0.001" },
      env: {
        X402_PAY_TO: "0x1111111111111111111111111111111111111111",
        X402_PAY_TO_EIP155_8453: "0x2222222222222222222222222222222222222222",
      },
    });

    expect(config.payToByNetwork[EVM_OTHER]).toBe("0x2222222222222222222222222222222222222222");
    expect(config.payToByNetwork[EVM]).toBe("0x1111111111111111111111111111111111111111");
  });

  it("accepts a namespace-only suffix", () => {
    const config = resolveConfig({
      facilitatorUrl: "https://facilitator.example.com",
      networks: [EVM, SVM],
      routes: { "GET /w": "0.001" },
      env: { X402_PAY_TO: PAY_TO, X402_PAY_TO_SOLANA: SVM_PAY_TO },
    });

    expect(config.payToByNetwork[SVM]).toBe(SVM_PAY_TO);
  });
});

describe("audit: timeouts that cannot work are refused", () => {
  it("rejects a negative maxTimeoutSeconds", () => {
    // Accepted before, and advertised on the wire as `-5`: conformant clients
    // refuse to sign against a negative window, so the buyer sees an unexplained
    // failure instead of a config error.
    expect(() =>
      resolveConfig({ ...BASE, network: EVM, routes: { "GET /w": "0.001" }, maxTimeoutSeconds: -5 }),
    ).toThrow(ConfigError);
  });

  it("rejects a NaN or fractional maxTimeoutSeconds", () => {
    for (const value of [Number.NaN, 0.5, 0]) {
      expect(
        () =>
          resolveConfig({ ...BASE, network: EVM, routes: { "GET /w": "0.001" }, maxTimeoutSeconds: value }),
        `maxTimeoutSeconds ${String(value)} should be rejected`,
      ).toThrow(ConfigError);
    }
  });

  it("rejects a facilitatorTimeoutMs above the platform ceiling", () => {
    // The SDK throws RangeError from its constructor, so this used to be an
    // uncaught startup crash with no field name in the message.
    expect(() =>
      resolveConfig({ ...BASE, network: EVM, routes: { "GET /w": "0.001" }, facilitatorTimeoutMs: 5_000_000_000 }),
    ).toThrow(/at most 2147483647/);
  });

  it("rejects a timeout env value with trailing garbage", () => {
    // `Number.parseInt("1e3")` is 1 — a 1 ms deadline, so every facilitator call
    // times out and the cause is invisible.
    expect(() =>
      resolveConfig({
        ...BASE,
        network: EVM,
        routes: { "GET /w": "0.001" },
        env: { X402_FACILITATOR_TIMEOUT_MS: "1e3" },
      }),
    ).toThrow(ConfigError);
  });
});

describe("audit: a Hono sub-app must not make routes free", () => {
  it("still answers 402 when the lens is mounted inside app.route()", async () => {
    // Measured before the fix: 200 with the payload, no challenge, no event.
    // `requiresPayment` was given `c.req.path`, which still carries the mount
    // prefix, so `GET /acme/weather` matched no route keyed `GET /weather`.
    const facilitator = await startMockFacilitator({ network: EVM });
    const lens = honoLens({
      facilitatorUrl: facilitator.url,
      network: EVM,
      payTo: PAY_TO,
      routes: { "GET /weather": "$0.001" },
      sinks: { console: false },
    });
    const events: string[] = [];
    lens.on(event => events.push(event.type));

    const sub = new Hono();
    sub.use("*", lens.middleware);
    sub.get("/weather", c => c.json({ secret: "PAID" }));
    const app = new Hono();
    app.route("/acme", sub);

    const server = createAdaptorServer({ fetch: app.fetch });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as AddressInfo).port;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/acme/weather`);
      const body = await response.text();

      expect(response.status).toBe(402);
      expect(body).not.toContain("PAID");
      expect(response.headers.get("payment-required")).toBeTruthy();
      expect(events).toContain("payment.required");
    } finally {
      await lens.close();
      await facilitator.close();
      await new Promise<void>((done, fail) => server.close(error => (error ? fail(error) : done())));
    }
  }, 20_000);

  it("still works when the lens is mounted at the root", async () => {
    // The fix must not break the flat case, which is the common one.
    const facilitator = await startMockFacilitator({ network: EVM });
    const lens = honoLens({
      facilitatorUrl: facilitator.url,
      network: EVM,
      payTo: PAY_TO,
      routes: { "GET /weather": "$0.001" },
      sinks: { console: false },
    });
    const app = new Hono();
    app.use("*", lens.middleware);
    app.get("/weather", c => c.json({ ok: true }));

    const server = createAdaptorServer({ fetch: app.fetch });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as AddressInfo).port;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/weather`);
      expect(response.status).toBe(402);
    } finally {
      await lens.close();
      await facilitator.close();
      await new Promise<void>((done, fail) => server.close(error => (error ? fail(error) : done())));
    }
  }, 20_000);
});

describe("audit: the Express observer must not touch unprotected responses", () => {
  it("leaves another handler's 402 body alone and emits no payment event", async () => {
    // The observer was attached before `requiresPayment`, so an unprotected route
    // that answered its own 402 had its body rewritten and produced a
    // `payment.required` event for a payment nobody requested.
    //
    // A reachable facilitator is used so the only events that could appear are
    // the ones under test: with a dead facilitator an unrelated
    // `facilitator.error` would make an empty-events assertion fail for the wrong
    // reason.
    const facilitator = await startMockFacilitator({ network: EVM });
    const lens = expressLens({
      facilitatorUrl: facilitator.url,
      network: EVM,
      payTo: PAY_TO,
      routes: { "GET /paid": "$0.001" },
      sinks: { console: false },
    });
    const events: string[] = [];
    lens.on(event => events.push(event.type));

    const app = express();
    app.use(lens.middleware);
    app.get("/free", (_req, res) => {
      res.setHeader(
        "payment-required",
        Buffer.from(JSON.stringify({ x402Version: 2, accepts: [] })).toString("base64"),
      );
      res.status(402).json({ free: "yes" });
    });

    const server = createServer(app);
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as AddressInfo).port;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/free`);
      const body = (await response.json()) as Record<string, unknown>;

      expect(body).toEqual({ free: "yes" });
      expect(body.x402Version).toBeUndefined();
      // Give the emit path a chance to run late.
      await new Promise(done => setTimeout(done, 100));
      // Specifically no payment event: the body rewrite and the event came from
      // the same observer, so one without the other would be a partial fix.
      expect(events).not.toContain("payment.required");
    } finally {
      await lens.close();
      await facilitator.close();
      await new Promise<void>((done, fail) => server.close(error => (error ? fail(error) : done())));
    }
  }, 20_000);
});

describe("audit: a custom exact scheme must not disable the others", () => {
  /** A scheme instance the resource server can register. */
  function fakeExact() {
    return {
      scheme: "exact",
      defaultAssetTransferMethod: "eip3009",
      paymentFlows: { eip3009: { supported: ["authorization"], default: "authorization" } },
    } as never;
  }

  it("still registers upto when the caller supplied their own exact", () => {
    // `buildServers` used to skip `registerScheme` entirely in this case, and
    // that is the only place `upto` is registered — so `ready` rejected with
    // "No scheme implementation registered for upto" and the server never
    // booted.
    const config = resolveConfig({
      facilitatorUrl: "https://facilitator.example.com",
      network: EVM,
      payTo: PAY_TO,
      routes: [{ route: "GET /w", price: "0.001", scheme: "upto" }],
    });

    const servers = buildServers(config, {
      sinks: { console: false },
      extraSchemes: [{ network: EVM, scheme: "exact", implementation: fakeExact() }],
    });

    expect(servers.server.getRegisteredScheme(EVM as never, "upto")).toBeDefined();
    expect(servers.server.getRegisteredScheme(EVM as never, "exact")).toBeDefined();
  });

  it("still accepts a network this package does not ship", () => {
    // The mirror case: `xrpl` has no built-in scheme, so the caller's
    // registration must be the whole answer rather than reaching the namespace
    // throw.
    const config = resolveConfig({
      facilitatorUrl: "https://facilitator.example.com",
      network: EVM,
      payTo: PAY_TO,
      routes: { "GET /w": "0.001" },
    });

    expect(() =>
      buildServers(config, {
        sinks: { console: false },
        extraSchemes: [{ network: "xrpl:1", scheme: "exact", implementation: fakeExact() }],
      }),
    ).not.toThrow();
  });
});
