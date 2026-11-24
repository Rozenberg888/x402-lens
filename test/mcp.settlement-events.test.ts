/**
 * The MCP adapter's settlement events.
 *
 * Coverage showed `emitFailure` and `emitSettle` were never executed: every test
 * so far either refused a configuration or inspected the challenge, so the three
 * events an operator reads — `payment.failed`, `payment.settled`,
 * `payment.settle_failed` — had no assertion behind them. Same shape as the
 * `accepts[0]` bug that shipped in 0.1.0: a green suite through an unexamined
 * path.
 *
 * These drive a paid call through the real SDK wrapper, so the resource-server
 * fake has to carry the methods the wrapper actually calls. It is written to the
 * SDK's call list, not to a guess:
 *
 *   getRegisteredScheme, createPaymentRequiredResponse, findMatchingRequirements,
 *   validateExtensions, getPaymentFlow, verifyPayment, settlePayment,
 *   createPaymentCancellationDispatcher
 *
 * Driving the wrapper rather than the private helpers is deliberate: it is also
 * how the `isError` defect below was found. The SDK reports a failed tool call as
 * a *result* with `isError: true`, not as a throw, and the adapter used to call
 * that a settlement.
 */

import { describe, expect, it } from "vitest";
import type { LensEvent } from "@x402-lens/core";
import { mcpLens } from "@x402-lens/mcp";

const NETWORK = "eip155:84532";
const PAYER = "0x857b06519E91e3A54538791bDAbd0E22373e36b66";

const REQUIREMENTS = {
  scheme: "exact",
  network: NETWORK,
  amount: "10000",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
  maxTimeoutSeconds: 60,
};

/** The payment a client presents, in the shape the SDK accepts from `_meta`. */
const PAYMENT_PAYLOAD = {
  x402Version: 2,
  scheme: "exact",
  network: NETWORK,
  payload: { signature: `0x${"ab".repeat(65)}` },
};

interface SettleOutcome {
  success: boolean;
  errorReason?: string;
  transaction?: string;
  network?: string;
  payer?: string;
}

/**
 * A resource server good enough for one paid tool call.
 *
 * @param settle - What `/settle` should answer
 * @param verifyValid - Whether verification succeeds
 */
function fakeServer(settle: SettleOutcome, verifyValid = true) {
  const requirements = { ...REQUIREMENTS };
  return {
    getRegisteredScheme: () => ({
      scheme: "exact",
      defaultAssetTransferMethod: "eip3009",
      paymentFlows: { eip3009: { supported: ["authorization"], default: "authorization" } },
    }),
    createPaymentRequiredResponse: async () => ({
      x402Version: 2,
      accepts: [requirements],
      resource: { url: "mcp://lens-test/search" },
    }),
    findMatchingRequirements: () => requirements,
    validateExtensions: () => ({ valid: true }),
    // One of `authorization`, `upfront`, `escrow` — not the transfer method name.
    getPaymentFlow: () => "authorization",
    verifyPayment: async () => ({ isValid: verifyValid, payer: PAYER }),
    settlePayment: async () => settle,
    createPaymentCancellationDispatcher: () => ({ cancel: async () => undefined }),
  } as never;
}

/** Run one paid tool call and collect the events it produced. */
async function paidCall(
  settle: SettleOutcome,
  options: {
    handler?: () => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>;
    verifyValid?: boolean;
  } = {},
): Promise<{ events: LensEvent[]; result: unknown }> {
  const lens = mcpLens({ sinks: { console: false } });
  const events: LensEvent[] = [];
  lens.on(event => events.push(event));

  const tool = lens.paidTool({
    server: fakeServer(settle, options.verifyValid ?? true),
    toolName: "search",
    resource: { url: "mcp://lens-test/search" },
    accepts: [REQUIREMENTS as never],
  });

  const handler = tool.wrap(
    options.handler ?? (async () => ({ content: [{ type: "text" as const, text: "paid" }] })),
  );

  // `_meta` carries the payment: without it the SDK answers with a challenge and
  // never settles.
  const result = await handler({ query: "x" }, { _meta: { "x402/payment": PAYMENT_PAYLOAD } });
  await lens.close();
  return { events, result };
}

describe("mcp: successful settlement", () => {
  it("emits payment.settled with the transaction and buyer", async () => {
    const { events } = await paidCall({
      success: true,
      transaction: "0xsettled",
      network: NETWORK,
      payer: PAYER,
    });

    const settled = events.find(event => event.type === "payment.settled");
    expect(settled).toBeDefined();
    expect(settled?.txHash).toBe("0xsettled");
    // The buyer comes from the settle response: with no HTTP request there is no
    // other place the SDK reports who paid.
    expect(settled?.buyer).toBe(PAYER);
  });

  it("reports no findings for a clean settlement", async () => {
    const { events } = await paidCall({ success: true, transaction: "0xabc", network: NETWORK });

    const settled = events.find(event => event.type === "payment.settled");
    expect(settled?.findings ?? []).toHaveLength(0);
  });
});

describe("mcp: settlement failure as the SDK reports it", () => {
  it("reports a refused settlement as a challenge, because that is all the SDK gives", async () => {
    // Measured, not assumed: when `/settle` answers `success: false`, the SDK
    // builds a *challenge* (`createSettlementFailedResult` → `createPayment
    // RequiredResult`) and attaches no `_meta`. The terminal `insufficient_funds`
    // and the non-terminal `settlement_pending` produce byte-identical results —
    // same challenge, same text, no reason and no flag.
    //
    // So `payment.settle_failed` cannot be produced here by reading the result.
    // The adapter reports what it can see: a payment is still due. That is
    // truthful — the resource was not delivered — but it is not the whole story,
    // which is why the reason is unavailable rather than invented.
    for (const settle of [
      { success: false, errorReason: "insufficient_funds", network: NETWORK },
      { success: false, errorReason: "settlement_pending", network: NETWORK },
    ]) {
      const { events } = await paidCall(settle);

      expect(events.some(event => event.type === "payment.required")).toBe(true);
      // The dangerous alternative: reporting a settlement that failed.
      expect(events.some(event => event.type === "payment.settled")).toBe(false);
    }
  });

  it("does not manufacture a settle_failed event from a challenge", async () => {
    // A refusal that carries a challenge is indistinguishable from an unpaid
    // call. Emitting `payment.settle_failed` from it would invent the reason, and
    // a wrong reason is worse than a missing one: `settlement_pending` means
    // "retrying may pay twice", `insufficient_funds` means "retrying is safe".
    const { events } = await paidCall({ success: false, errorReason: "insufficient_funds" });

    expect(events.some(event => event.type === "payment.settle_failed")).toBe(false);
  });
});

describe("mcp: a tool call that errored", () => {
  it("does not claim a settlement for an error result", async () => {
    // The defect this file was written to find. The SDK reports a failed handler
    // as `{ content, isError: true }` with no `_meta`, and "no settle response and
    // no challenge" was read as "settled" — an observability layer stating that
    // money moved when it had not.
    const { events, result } = await paidCall(
      { success: true, transaction: "0xabc", network: NETWORK },
      {
        handler: async () => ({
          content: [{ type: "text" as const, text: "handler exploded" }],
          isError: true,
        }),
      },
    );

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(events.some(event => event.type === "payment.settled")).toBe(false);
  });

  it("reports the error text as the failure reason", async () => {
    const { events } = await paidCall(
      { success: true, transaction: "0xabc", network: NETWORK },
      {
        handler: async () => ({
          content: [{ type: "text" as const, text: "could not read the file" }],
          isError: true,
        }),
      },
    );

    const failed = events.find(event => event.type === "payment.failed");
    expect((failed as { reason?: string }).reason).toContain("could not read the file");
  });
});

describe("mcp: an unpaid call", () => {
  it("emits payment.required, not a settlement", async () => {
    const lens = mcpLens({ sinks: { console: false } });
    const events: LensEvent[] = [];
    lens.on(event => events.push(event));

    const tool = lens.paidTool({
      server: fakeServer({ success: true }),
      toolName: "search",
      resource: { url: "mcp://lens-test/search" },
      accepts: [REQUIREMENTS as never],
    });

    // No `_meta` at all: the SDK answers with a challenge.
    await tool.wrap(async () => ({ content: [{ type: "text" as const, text: "paid" }] }))(
      { query: "x" },
      {},
    );

    expect(events.some(event => event.type === "payment.required")).toBe(true);
    expect(events.some(event => event.type === "payment.settled")).toBe(false);
    await lens.close();
  });
});
