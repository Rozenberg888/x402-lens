/**
 * Negative and edge paths for the Hono adapter.
 *
 * The Express suite covers all of these, and the first version of the Hono
 * suite did not: it tested 402, settle, grant and CORS, then stopped. That is
 * the shape of coverage that looks complete and is not — every one of these
 * paths is a branch in `packages/hono/src/index.ts` that no test executed, so a
 * regression would reach users silently.
 *
 * Each test also states the observable contract, not just the status code:
 * a buyer-facing body must stay free of internal detail, and an event must
 * carry the reason.
 */

import { createAdaptorServer } from "@hono/node-server";
import { Hono } from "hono";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it, vi } from "vitest";
import * as honoObserve from "../packages/hono/src/observe.js";
import type { LensEvent } from "@x402-lens/core";
import { ConfigError } from "@x402-lens/core";
import { paymentLens, type PaymentLensOptions } from "@x402-lens/hono";
import { startMockFacilitator } from "./helpers/mockFacilitator.js";

const NETWORK = "eip155:84532";
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";

const started: Array<() => Promise<void>> = [];

afterAll(async () => {
  for (const close of started) await close();
});

interface Harness {
  baseUrl: string;
  lens: ReturnType<typeof paymentLens>;
  events: LensEvent[];
  handlerCalls: { count: number };
}

/**
 * Start a Hono app with the lens mounted in front of one route.
 *
 * `handler` is overridable so a test can make the application handler fail —
 * which is a different path from the middleware failing, and the one where a
 * paid request must not be charged silently.
 */
async function startServer(
  options: PaymentLensOptions = {},
  handler?: () => Response | Promise<Response>,
): Promise<Harness> {
  const events: LensEvent[] = [];
  const handlerCalls = { count: 0 };

  const lens = paymentLens({
    facilitatorUrl: options.facilitatorUrl ?? "http://127.0.0.1:1",
    network: NETWORK,
    payTo: PAY_TO,
    routes: { "GET /weather": "$0.001" },
    sinks: { console: false },
    ...options,
  });
  lens.on(event => events.push(event));

  const app = new Hono();
  app.use("*", lens.middleware);
  app.get("/weather", c => {
    handlerCalls.count += 1;
    return handler ? handler() : c.json({ ok: true });
  });

  const server = createAdaptorServer({ fetch: app.fetch });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  started.push(async () => {
    await lens.close();
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    );
  });

  return { baseUrl: `http://127.0.0.1:${address.port}`, lens, events, handlerCalls };
}

describe("hono edge: configuration refused at construction", () => {
  it("rejects an empty routesConfig instead of silently unprotecting", () => {
    expect(() =>
      paymentLens({
        facilitatorUrl: "http://127.0.0.1:1",
        network: NETWORK,
        payTo: PAY_TO,
        routes: { "GET /weather": "$0.001" },
        routesConfig: {},
        sinks: { console: false },
      }),
    ).toThrow(ConfigError);
  });

  it("rejects a non-string, non-object route price", () => {
    expect(() =>
      paymentLens({
        facilitatorUrl: "http://127.0.0.1:1",
        network: NETWORK,
        payTo: PAY_TO,
        // The cast is the point: a JS caller can pass anything.
        routes: { "GET /weather": 42 as unknown as string },
        sinks: { console: false },
      }),
    ).toThrow(ConfigError);
  });
});

describe("hono edge: facilitator unreachable", () => {
  it("answers 502 with a stable body and emits the failure once", async () => {
    // Port 1 refuses immediately; the probe fails and `ready` rejects.
    const harness = await startServer();

    const first = await fetch(`${harness.baseUrl}/weather`);
    expect(first.status).toBe(502);
    expect(await first.json()).toEqual({
      error: "facilitator_unavailable",
      code: "FACILITATOR_UNAVAILABLE",
    });

    // A second request must not duplicate the INIT event: the funnel is once.
    await fetch(`${harness.baseUrl}/weather`);
    const initEvents = harness.events.filter(
      event => event.type === "facilitator.error" && event.route === "INIT /supported",
    );
    expect(initEvents).toHaveLength(1);

    expect(harness.handlerCalls.count).toBe(0);
  });

  it("keeps the facilitator error detail off the buyer body", async () => {
    const harness = await startServer();
    const response = await fetch(`${harness.baseUrl}/weather`);
    const body = (await response.text()).toLowerCase();

    // The event carries the reason; the body must not leak a URL, a stack, or
    // an internal error string to an unauthenticated caller.
    expect(body).not.toContain("econnrefused");
    expect(body).not.toContain("127.0.0.1");
    expect(body).not.toContain("stack");
  });
});

describe("hono edge: grant callback", () => {
  it("denies when the callback throws, without leaking the error", async () => {
    const harness = await startServer({
      grant: () => {
        throw new Error("grant exploded with internal detail");
      },
    });

    const response = await fetch(`${harness.baseUrl}/weather`);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "access_denied" });

    const denied = harness.events.find(event => event.type === "access.denied");
    expect(denied?.reason).toContain("grant exploded with internal detail");
    expect(harness.handlerCalls.count).toBe(0);
  });

  it("truncates a long denial reason on the event", async () => {
    const longReason = "x".repeat(500);
    const harness = await startServer({ grant: () => longReason });

    await fetch(`${harness.baseUrl}/weather`);

    const denied = harness.events.find(event => event.type === "access.denied");
    // The event is a log line, not a payload: 200 characters is the cap.
    expect(denied?.reason).toHaveLength(200);
  });

  it("reports a throwing grant as denied, not as a facilitator failure", async () => {
    const harness = await startServer({
      grant: () => {
        throw new Error("boom");
      },
    });

    const response = await fetch(`${harness.baseUrl}/weather`);
    // A broken grant is an access decision, so 403 — not 502, which would send
    // the operator looking at the facilitator.
    expect(response.status).toBe(403);
    expect(
      harness.events.some(
        event => event.type === "facilitator.error" && event.route !== "INIT /supported",
      ),
    ).toBe(false);
  });
});

describe("hono edge: middleware failure classification", () => {
  it("answers 500 MIDDLEWARE_ERROR when the middleware itself explodes", async () => {
    const facilitator = await startMockFacilitator({ network: NETWORK });
    started.push(() => facilitator.close());

    const harness = await startServer({ facilitatorUrl: facilitator.url });
    await harness.lens.ready;

    // Make the SDK-side check throw, which is a lens/adapter bug rather than a
    // facilitator outage.
    harness.lens.httpServer.requiresPayment = () => {
      throw new Error("adapter exploded");
    };

    const response = await fetch(`${harness.baseUrl}/weather`);

    // 500 with MIDDLEWARE_ERROR, not 502: 502 sends an operator to the
    // facilitator's status page for a bug in our own code.
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "internal_error",
      code: "MIDDLEWARE_ERROR",
    });
    expect(harness.handlerCalls.count).toBe(0);
  });

  it("answers 500 MIDDLEWARE_ERROR when payment observation explodes after the SDK runs", async () => {
    const facilitator = await startMockFacilitator({ network: NETWORK });
    started.push(() => facilitator.close());

    const harness = await startServer({ facilitatorUrl: facilitator.url });
    await harness.lens.ready;

    const spy = vi
      .spyOn(honoObserve, "observePaymentRequired")
      .mockRejectedValue(new Error("observe exploded"));

    try {
      const response = await fetch(`${harness.baseUrl}/weather`);

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "internal_error",
        code: "MIDDLEWARE_ERROR",
      });
      expect(harness.handlerCalls.count).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("hono edge: malformed payment", () => {
  it("answers 402 rather than 500 for an undecodable PAYMENT-SIGNATURE", async () => {
    const facilitator = await startMockFacilitator({ network: NETWORK });
    started.push(() => facilitator.close());

    const harness = await startServer({ facilitatorUrl: facilitator.url });

    const response = await fetch(`${harness.baseUrl}/weather`, {
      headers: { "PAYMENT-SIGNATURE": "not-base64-at-all" },
    });

    // A garbage header is a buyer error; answering 500 would page an operator
    // for something a client did.
    expect(response.status).toBe(402);
    expect(harness.handlerCalls.count).toBe(0);
  });
});

describe("hono edge: OPTIONS without cors", () => {
  it("does not answer preflight itself when cors is off", async () => {
    const harness = await startServer({ grant: () => true });

    const response = await fetch(`${harness.baseUrl}/weather`, { method: "OPTIONS" });

    // With cors off the app owns preflight. The lens must neither answer 204
    // nor reach the payment path — a granted GET route is still a route.
    expect(response.status).not.toBe(402);
    expect(harness.handlerCalls.count).toBe(0);
  });
});

describe("hono edge: application handler fails after payment is verified", () => {
  it("does not report a settled payment when the handler throws", async () => {
    const facilitator = await startMockFacilitator({ network: NETWORK });
    started.push(() => facilitator.close());

    const harness = await startServer({ facilitatorUrl: facilitator.url }, () => {
      throw new Error("handler exploded");
    });
    await harness.lens.ready;

    const challenge = await fetch(`${harness.baseUrl}/weather`);
    const header = challenge.headers.get("payment-required");
    expect(header).toBeTruthy();

    const { decodePaymentRequiredHeader } = await import("@x402/core/http");
    const paymentRequired = decodePaymentRequiredHeader(header as string) as {
      resource?: unknown;
      accepts: Array<Record<string, unknown>>;
    };
    const accepted = paymentRequired.accepts[0];

    const paid = await fetch(`${harness.baseUrl}/weather`, {
      headers: {
        "PAYMENT-SIGNATURE": Buffer.from(
          JSON.stringify({
            x402Version: 2,
            resource: paymentRequired.resource,
            accepted,
            payload: {
              signature: `0x${"ab".repeat(65)}`,
              authorization: {
                from: PAY_TO,
                to: accepted?.payTo,
                value: accepted?.amount,
                validAfter: "0",
                validBefore: "9999999999",
                nonce: `0x${"cd".repeat(32)}`,
              },
            },
          }),
          "utf8",
        ).toString("base64"),
      },
    });

    // The handler threw, so the buyer must not receive a success response.
    expect(paid.status).toBeGreaterThanOrEqual(500);
    expect(harness.handlerCalls.count).toBe(1);

    // And the lens must not claim a settlement it cannot verify: a
    // payment.settled here would tell an operator money moved for a failed
    // request.
    expect(harness.events.some(event => event.type === "payment.settled")).toBe(false);
  });
});
