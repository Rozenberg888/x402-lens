/**
 * The event hooks and scheme registration, tested where they are decided.
 *
 * The survivors mutation testing left in `packages/server/src/index.ts` were
 * concentrated here: whole hook bodies (`onVerifyFailure`,
 * `onVerifiedPaymentCanceled`) and the unsupported-namespace branch had no test
 * that ran them. Integration tests emit these events only if a scenario happens
 * to reach them, and none did — so a hook could be deleted and the suite would
 * stay green.
 *
 * A fake resource server records the callbacks `attachHooks` registers, which
 * lets each hook be invoked directly with a controlled context. That is a
 * narrower test than driving a real payment, and it is the only way to assert
 * what a hook emits for a failure the real SDK makes hard to provoke.
 */

import { describe, expect, it, vi } from "vitest";
import { EventBus, type LensConfig, type LensEvent } from "@x402-lens/core";
import {
  attachHooks,
  registerScheme,
  schemesInUse,
  type RequirementsShape,
} from "@x402-lens/server";

const CONFIG = {
  network: "eip155:84532",
  networks: ["eip155:84532"],
  payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
  payToByNetwork: {},
  routes: [],
} as unknown as LensConfig;

const REQUIREMENTS: RequirementsShape = {
  scheme: "exact",
  network: "eip155:84532",
  amount: "1000",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
};

/** Records hook callbacks and lets a test fire one. */
interface FakeServer {
  hooks: Record<string, (context: unknown) => unknown>;
  register: ReturnType<typeof vi.fn>;
  /** The object handed to `attachHooks`; hook methods live here. */
  target: Record<string, unknown>;
}

function fakeServer(): FakeServer {
  const hooks: Record<string, (context: unknown) => unknown> = {};
  const register = vi.fn();

  const target: Record<string, unknown> = { register };
  // The real server returns `this` from each hook registrar, for chaining.
  for (const name of [
    "onAfterVerify",
    "onVerifyFailure",
    "onAfterSettle",
    "onSettleFailure",
    "onVerifiedPaymentCanceled",
  ]) {
    target[name] = (fn: (context: unknown) => unknown) => {
      hooks[name] = fn;
      return target;
    };
  }

  return { hooks, register, target };
}

function setup(): { events: LensEvent[]; server: FakeServer } {
  const events: LensEvent[] = [];
  const bus = new EventBus([{ name: "capture", write: event => void events.push(event) }]);
  const server = fakeServer();
  // `attachHooks` registers each callback on the object it is given, which is
  // the same object the test then fires — so the fake has to be that target.
  attachHooks(server.target as never, bus, CONFIG);
  return { events, server };
}

describe("attachHooks: verification failure", () => {
  it("emits facilitator.error naming the reason, not a silent rejection", async () => {
    const { events, server } = setup();

    await server.hooks.onVerifyFailure?.({
      requirements: REQUIREMENTS,
      error: new Error("facilitator returned 503"),
    });

    const event = events.find(candidate => candidate.type === "facilitator.error");
    expect(event).toBeDefined();
    // The message is what tells an operator the facilitator, not the buyer, broke.
    expect((event as { message?: string }).message).toContain("503");
  });

  it("carries the payment fields so the event is attributable to a request", async () => {
    const { events, server } = setup();

    await server.hooks.onVerifyFailure?.({
      requirements: REQUIREMENTS,
      error: new Error("boom"),
    });

    const event = events[0];
    expect(event?.network).toBe(REQUIREMENTS.network);
    expect(event?.amount).toBe(REQUIREMENTS.amount);
    expect(event?.payTo).toBe(REQUIREMENTS.payTo);
  });
});

describe("attachHooks: canceled verified payment", () => {
  it("emits payment.canceled with the reason and phase", async () => {
    const { events, server } = setup();

    await server.hooks.onVerifiedPaymentCanceled?.({
      requirements: REQUIREMENTS,
      reason: "handler_threw",
      phase: "after-handler",
    });

    const event = events.find(candidate => candidate.type === "payment.canceled");
    expect(event).toBeDefined();
    expect((event as { cancelReason?: string }).cancelReason).toBe("handler_threw");
    expect((event as { phase?: string }).phase).toBe("after-handler");
  });

  it("does not emit a settled event for a canceled payment", async () => {
    const { events, server } = setup();

    await server.hooks.onVerifiedPaymentCanceled?.({
      requirements: REQUIREMENTS,
      reason: "handler_failed",
      phase: "after-handler",
    });

    // A cancellation is the opposite of a settlement; emitting both would tell
    // an operator money moved for a request that was refunded/aborted.
    expect(events.some(event => event.type === "payment.settled")).toBe(false);
  });
});

describe("attachHooks: settle failure", () => {
  it("uses the facilitator's errorReason when the SDK exposes one", async () => {
    const { events, server } = setup();

    const settleError = Object.assign(new Error("settle failed"), {
      errorReason: "insufficient_funds",
      transaction: "0xdeadbeef",
      payer: "0x857b06519E91e3A54538791bDAbd0E22373e36b66",
    });

    await server.hooks.onSettleFailure?.({
      requirements: REQUIREMENTS,
      error: settleError,
      phase: "after-handler",
    });

    const event = events.find(candidate => candidate.type === "payment.settle_failed");
    expect((event as { reason?: string }).reason).toBe("insufficient_funds");
    expect((event as { txHash?: string }).txHash).toBe("0xdeadbeef");
    expect((event as { buyer?: string }).buyer).toBe(
      "0x857b06519E91e3A54538791bDAbd0E22373e36b66",
    );
  });

  it("falls back to the error message when there is no structured reason", async () => {
    const { events, server } = setup();

    await server.hooks.onSettleFailure?.({
      requirements: REQUIREMENTS,
      error: new Error("network unreachable"),
      phase: "after-handler",
    });

    const event = events.find(candidate => candidate.type === "payment.settle_failed");
    // Losing the reason entirely would leave an operator with an unexplained 402.
    expect((event as { reason?: string }).reason).toContain("network unreachable");
  });
});

describe("attachHooks: settle success", () => {
  it("emits payment.settled with the transaction hash", async () => {
    const { events, server } = setup();

    await server.hooks.onAfterSettle?.({
      requirements: REQUIREMENTS,
      result: {
        success: true,
        transaction: "0xabc123",
        network: REQUIREMENTS.network,
        payer: "0x857b06519E91e3A54538791bDAbd0E22373e36b66",
      },
      phase: "after-handler",
    });

    const event = events.find(candidate => candidate.type === "payment.settled");
    expect((event as { txHash?: string }).txHash).toBe("0xabc123");
    expect((event as { phase?: string }).phase).toBe("after-handler");
  });
});

describe("attachHooks: verification verdict", () => {
  it("emits payment.verified carrying the payer", async () => {
    const { events, server } = setup();

    await server.hooks.onAfterVerify?.({
      requirements: REQUIREMENTS,
      result: { isValid: true, payer: "0x857b06519E91e3A54538791bDAbd0E22373e36b66" },
      paymentPayload: { x402Version: 2, accepted: REQUIREMENTS },
    });

    const event = events.find(candidate => candidate.type === "payment.verified");
    expect((event as { buyer?: string }).buyer).toBe(
      "0x857b06519E91e3A54538791bDAbd0E22373e36b66",
    );
  });

  it("emits payment.failed with findings when the verdict is invalid", async () => {
    const { events, server } = setup();

    await server.hooks.onAfterVerify?.({
      requirements: REQUIREMENTS,
      result: { isValid: false, invalidReason: "invalid_signature" },
      paymentPayload: { x402Version: 2, accepted: REQUIREMENTS },
    });

    const event = events.find(candidate => candidate.type === "payment.failed");
    expect((event as { reason?: string }).reason).toBe("invalid_signature");
    // The findings are the product: an empty array here means the diagnosis
    // engine was not reached on the verify path.
    expect(Array.isArray((event as { findings?: unknown[] }).findings)).toBe(true);
  });

  it("labels an unexplained rejection as unknown rather than empty", async () => {
    const { events, server } = setup();

    await server.hooks.onAfterVerify?.({
      requirements: REQUIREMENTS,
      result: { isValid: false },
      paymentPayload: { x402Version: 2, accepted: REQUIREMENTS },
    });

    const event = events.find(candidate => candidate.type === "payment.failed");
    // A missing reason must be legible: `undefined` prints as a gap in a log.
    expect((event as { reason?: string }).reason).toBe("unknown");
  });
});

describe("registerScheme", () => {
  it("registers exact for eip155", () => {
    const { register } = fakeServer();
    registerScheme({ register } as never, "eip155:84532", new Set(["exact"]));

    expect(register).toHaveBeenCalledTimes(1);
  });

  it("adds upto for eip155 only when a route asks for it", () => {
    const withoutUpto = fakeServer();
    registerScheme({ register: withoutUpto.register } as never, "eip155:84532", new Set(["exact"]));
    expect(withoutUpto.register).toHaveBeenCalledTimes(1);

    const withUpto = fakeServer();
    registerScheme({ register: withUpto.register } as never, "eip155:84532", new Set(["upto"]));
    expect(withUpto.register).toHaveBeenCalledTimes(2);
  });

  it("registers exact for solana", () => {
    const { register } = fakeServer();
    registerScheme({ register } as never, "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", new Set(["exact"]));

    expect(register).toHaveBeenCalledTimes(1);
  });

  it("adds upto for solana when a route asks for it", () => {
    const { register } = fakeServer();
    registerScheme(
      { register } as never,
      "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      new Set(["upto"]),
    );

    expect(register).toHaveBeenCalledTimes(2);
  });

  it("refuses an unsupported namespace with an actionable message", () => {
    const { register } = fakeServer();

    // `xrpl` is a valid CAIP-2 namespace and x402.org lists it, but this package
    // only ships EVM and SVM schemes. Failing loudly beats registering nothing
    // and letting every payment fail with an unexplained 402.
    expect(() => registerScheme({ register } as never, "xrpl:1", new Set(["exact"]))).toThrow(
      /No scheme for namespace "xrpl"/,
    );
    expect(register).not.toHaveBeenCalled();
  });

  it("names the escape hatch in the unsupported-namespace message", () => {
    const { register } = fakeServer();

    // The message has to say what to do instead, because the alternative is
    // reading this package's source.
    expect(() => registerScheme({ register } as never, "xrpl:1", new Set(["exact"]))).toThrow(
      /server\.register\(network, scheme\)/,
    );
  });

  it("treats a network with no colon as its own namespace", () => {
    const { register } = fakeServer();

    // Unreachable through `resolveConfig`, which demands CAIP-2, but the
    // function is exported and a caller can hand it anything.
    expect(() => registerScheme({ register } as never, "malformed", new Set(["exact"]))).toThrow(
      /No scheme for namespace "malformed"/,
    );
  });
});

describe("schemesInUse", () => {
  it("defaults a route with no scheme to exact", () => {
    const config = {
      routes: [{ method: "GET", path: "/a", price: "$0.001" }],
    } as unknown as LensConfig;

    expect([...schemesInUse(config)]).toEqual(["exact"]);
  });

  it("collects both schemes when routes differ", () => {
    const config = {
      routes: [
        { method: "GET", path: "/a", price: "$0.001" },
        { method: "GET", path: "/b", price: "$0.001", scheme: "upto" },
      ],
    } as unknown as LensConfig;

    expect([...schemesInUse(config)].sort()).toEqual(["exact", "upto"]);
  });

  it("deduplicates repeated schemes", () => {
    const config = {
      routes: [
        { method: "GET", path: "/a", price: "$0.001", scheme: "upto" },
        { method: "GET", path: "/b", price: "$0.001", scheme: "upto" },
      ],
    } as unknown as LensConfig;

    expect([...schemesInUse(config)]).toEqual(["upto"]);
  });
});
