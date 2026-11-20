/**
 * MCP adapter: configuration refused, and events emitted.
 *
 * The expensive paths (a real paid tool call through a facilitator) are covered
 * by the SDK's own suite and by the integration tests in this repository. What
 * is tested here is the part this package adds: refusing a configuration that
 * would silently make a tool free, and turning a tool result into the event an
 * operator or an agent can act on.
 */

import { describe, expect, it, vi } from "vitest";
import type { LensEvent } from "@x402-lens/core";
import { mcpLens } from "@x402-lens/mcp";

const REQUIREMENTS = {
  scheme: "exact",
  network: "eip155:84532",
  amount: "10000",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
  maxTimeoutSeconds: 60,
};

/**
 * A resource server stand-in.
 *
 * `createPaymentWrapper` calls `getRegisteredScheme` and then reads
 * `paymentFlows` off the returned scheme to validate the flow, so the fake has
 * to carry both. That is the minimum the SDK asks for; anything more would be
 * testing the SDK rather than this package.
 */
function fakeServer() {
  return {
    getRegisteredScheme: () => ({
      scheme: "exact",
      defaultAssetTransferMethod: "eip3009",
      paymentFlows: {
        eip3009: { supported: ["authorization"], default: "authorization" },
      },
    }),
  } as never;
}

function capture() {
  const events: LensEvent[] = [];
  return { events, onEvent: (event: LensEvent) => void events.push(event) };
}

describe("mcpLens: configuration refused", () => {
  it("throws when a tool is given no accepts entries", () => {
    const lens = mcpLens({ sinks: { console: false } });

    // An empty accepts array means the tool never asks for payment, which is
    // the exact failure a paid wrapper exists to prevent. It must be loud.
    expect(() =>
      lens.paidTool({ server: fakeServer(), toolName: "search", accepts: [] }),
    ).toThrow(/no accepts entries/);
  });

  it("names the tool in the error so the mistake is findable", () => {
    const lens = mcpLens({ sinks: { console: false } });

    expect(() =>
      lens.paidTool({ server: fakeServer(), toolName: "expensive_analysis", accepts: [] }),
    ).toThrow(/expensive_analysis/);
  });

  it("explains what to do instead of failing on a bare assertion", () => {
    const lens = mcpLens({ sinks: { console: false } });

    expect(() =>
      lens.paidTool({ server: fakeServer(), toolName: "x", accepts: [] }),
    ).toThrow(/buildPaymentRequirements/);
  });

  it("accepts a tool with one requirement", () => {
    const lens = mcpLens({ sinks: { console: false } });

    expect(() =>
      lens.paidTool({ server: fakeServer(), toolName: "search", accepts: [REQUIREMENTS as never] }),
    ).not.toThrow();
  });

  it("accepts a tool with several requirements", () => {
    const lens = mcpLens({ sinks: { console: false } });

    expect(() =>
      lens.paidTool({
        server: fakeServer(),
        toolName: "search",
        accepts: [
          REQUIREMENTS as never,
          { ...REQUIREMENTS, network: "eip155:8453" } as never,
        ],
      }),
    ).not.toThrow();
  });
});

describe("mcpLens: event bus", () => {
  it("shares one bus across tools, so close() flushes all of them", async () => {
    const lens = mcpLens({ sinks: { console: false } });
    lens.paidTool({ server: fakeServer(), toolName: "a", accepts: [REQUIREMENTS as never] });
    lens.paidTool({ server: fakeServer(), toolName: "b", accepts: [REQUIREMENTS as never] });

    // Two tools, one lifecycle: a server with five paid tools must not need
    // five close() calls, and must not leak four buses.
    await expect(lens.close()).resolves.toBeUndefined();
  });

  it("unsubscribes a listener without affecting the others", async () => {
    const first = capture();
    const second = capture();
    const lens = mcpLens({ sinks: { console: false } });

    const off = lens.on(first.onEvent);
    lens.on(second.onEvent);
    off();

    // Nothing is emitted without a tool call, so the assertion is that
    // unsubscribing does not throw and leaves the bus usable.
    await expect(lens.close()).resolves.toBeUndefined();
    expect(first.events).toHaveLength(0);
    expect(second.events).toHaveLength(0);
  });
});

describe("mcpLens: wrapping a handler", () => {
  it("returns a callback the MCP server can register", () => {
    const lens = mcpLens({ sinks: { console: false } });
    const tool = lens.paidTool({
      server: fakeServer(),
      toolName: "search",
      accepts: [REQUIREMENTS as never],
    });

    const handler = tool.wrap(async () => ({
      content: [{ type: "text", text: "results" }],
    }));

    expect(typeof handler).toBe("function");
    // The MCP SDK calls this with (args, extra); arity is part of the contract.
    expect(handler.length).toBe(2);
  });

  it("does not run the inner handler when payment is missing", async () => {
    const lens = mcpLens({ sinks: { console: false } });
    const tool = lens.paidTool({
      server: fakeServer(),
      toolName: "search",
      accepts: [REQUIREMENTS as never],
    });

    const inner = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "paid content" }],
    }));
    const handler = tool.wrap(inner);

    // No `_meta` payment, so the SDK answers with a challenge. The handler must
    // not run: that is the whole point of a paywall.
    const result = await handler({ query: "x" }, {});

    expect(inner).not.toHaveBeenCalled();
    expect(result.content.length).toBeGreaterThan(0);
  });
});
