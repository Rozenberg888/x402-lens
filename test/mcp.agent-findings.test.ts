/**
 * What an agent is told when its payment is refused.
 *
 * The question this file answers: should findings go into the MCP error
 * response? Some should. `agentFindings` splits them, and the split is the whole
 * design:
 *
 * - A `payment.*` finding is about the caller's own payload. Telling the caller
 *   is useful: it can fix the network, re-sign, expire window, and retry.
 * - A `challenge.*` finding is about the challenge this server generated. The
 *   caller cannot fix it. Telling it would make an agent retry with a different
 *   network forever, which is worse than saying nothing.
 *
 * Sending all findings, or none, are both wrong. Only the intersection helps.
 */

import { describe, expect, it } from "vitest";
import type { Finding } from "@x402-lens/core";
import { agentFindings, mcpLens } from "@x402-lens/mcp";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    severity: "warn",
    code: "network_not_offered",
    field: "payment.accepted.network",
    problem: "The client signed for a network the challenge does not offer.",
    fix: "Re-sign against one of the offered accepts[] entries.",
    ...overrides,
  };
}

/**
 * A resource server stand-in.
 *
 * `createPaymentWrapper` needs these methods, each discovered by the SDK
 * throwing when one is missing:
 *
 * - `getRegisteredScheme` + `paymentFlows` to validate the configured flow
 * - `createPaymentRequiredResponse` to build the 402 the caller receives
 * - `findMatchingRequirements` to match a presented payload against `accepts`
 *
 * A fake missing any of them makes the SDK answer "Internal Server Error" as
 * ordinary content, which is how each gap was found.
 */
function fakeServer() {
  const accepts = [REQUIREMENTS];

  return {
    getRegisteredScheme: () => ({
      scheme: "exact",
      defaultAssetTransferMethod: "eip3009",
      paymentFlows: {
        eip3009: { supported: ["authorization"], default: "authorization" },
      },
    }),
    createPaymentRequiredResponse: async (
      offered: unknown[],
      resource: unknown,
      error: string,
    ) => ({
      x402Version: 2,
      ...(error ? { error } : {}),
      resource,
      accepts: offered,
    }),
    findMatchingRequirements: (payload: { accepted?: { network?: string } }) =>
      accepts.filter(entry => entry.network === payload.accepted?.network)[0],
  } as never;
}

const REQUIREMENTS = {
  scheme: "exact",
  network: "eip155:84532",
  amount: "10000",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
  maxTimeoutSeconds: 60,
};

describe("agentFindings: the split", () => {
  it("keeps findings about the caller's payload", () => {
    // Exported through the package; imported here so the rule is testable
    // without driving a full tool call.
    const kept = agentFindings([finding()]);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.field).toBe("payment.accepted.network");
  });

  it("drops findings about the server's own challenge", () => {
    // The server advertised a malformed network. The caller cannot repair that,
    // and being told to would make it retry forever.
    const dropped = agentFindings([
      finding({
        severity: "error",
        code: "network_not_caip2",
        field: "challenge.accepts.network",
      }),
    ]);

    expect(dropped).toEqual([]);
  });

  it("separates a mixed list", () => {
    const kept = agentFindings([
      finding({ field: "payment.accepted.network", code: "network_not_offered" }),
      finding({ field: "challenge.accepts.network", code: "network_not_caip2" }),
      finding({ field: "payment.authorization.validBefore", code: "authorization_expired" }),
    ]);

    expect(kept.map(item => item.code).sort()).toEqual([
      "authorization_expired",
      "network_not_offered",
    ]);
  });

  it("returns an empty list unchanged", () => {
    expect(agentFindings([])).toEqual([]);
  });
});

describe("mcpLens: the diagnosis reaches the caller", () => {
  it("adds a labelled diagnosis item after the challenge", async () => {
    const lens = mcpLens({ sinks: { console: false } });
    const tool = lens.paidTool({
      server: fakeServer(),
      toolName: "search",
      accepts: [REQUIREMENTS as never],
      resource: { url: "mcp://tool/search" },
    });

    const handler = tool.wrap(async () => ({
      content: [{ type: "text" as const, text: "paid content" }],
    }));

    // A payload the challenge cannot accept: it signs for a network that is not
    // offered. That is a `payment.*` finding, which the caller can fix.
    const wrongNetworkPayload = {
      x402Version: 2,
      accepted: { ...REQUIREMENTS, network: "eip155:8453" },
      payload: {
        signature: `0x${"ab".repeat(65)}`,
        authorization: {
          from: REQUIREMENTS.payTo,
          to: REQUIREMENTS.payTo,
          value: REQUIREMENTS.amount,
          validAfter: "0",
          validBefore: "9999999999",
          nonce: `0x${"cd".repeat(32)}`,
        },
      },
    };

    const result = await handler(
      { query: "x" },
      { _meta: { "x402/payment": wrongNetworkPayload } },
    );

    // The challenge must remain the first item and stay parseable: clients read
    // it positionally, and prepending anything would break them.
    expect(result.content[0]?.type).toBe("text");
    expect(() => JSON.parse(String(result.content[0]?.text))).not.toThrow();

    // The diagnosis must be present — not "present if the engine happened to
    // find something". A wrong-network payload always produces one.
    const diagnosisIndex = result.content.findIndex(
      item => item.type === "text" && String(item.text).includes("x402-lens diagnosis"),
    );
    expect(diagnosisIndex).toBeGreaterThanOrEqual(0);
    // The diagnosis comes after the challenge, never before it.
    expect(diagnosisIndex).toBe(result.content.length - 1);

    const diagnosisText = String(result.content[diagnosisIndex]?.text ?? "");
    // Labelled as advice about the caller's own payload, so an agent does not
    // mistake it for part of the challenge.
    expect(diagnosisText).toContain("your payment payload");
  });

  it("does not add a diagnosis when there is nothing actionable", async () => {
    const lens = mcpLens({ sinks: { console: false } });
    const tool = lens.paidTool({
      server: fakeServer(),
      toolName: "search",
      accepts: [REQUIREMENTS as never],
    });

    const handler = tool.wrap(async () => ({
      content: [{ type: "text" as const, text: "paid content" }],
    }));

    // No payment at all: the caller gets a challenge to sign, which is the
    // normal path and leaves it nothing to fix.
    const result = await handler({ query: "x" }, {});

    const diagnosis = result.content.filter(
      item => item.type === "text" && String(item.text).includes("x402-lens diagnosis"),
    );
    // An empty diagnosis item would be noise an agent pays tokens to read.
    expect(diagnosis).toHaveLength(0);
  });

  it("never exposes findings about the server's own challenge", async () => {
    const lens = mcpLens({ sinks: { console: false } });
    const tool = lens.paidTool({
      // A challenge advertising a non-CAIP-2 network is the server's mistake.
      server: fakeServer(),
      toolName: "search",
      accepts: [{ ...REQUIREMENTS, network: "base-sepolia" } as never],
      resource: { url: "mcp://tool/search" },
    });

    const handler = tool.wrap(async () => ({
      content: [{ type: "text" as const, text: "paid content" }],
    }));

    const result = await handler({ query: "x" }, {});

    const text = result.content.map(item => String(item.text ?? "")).join("\n");
    // Telling the caller to fix the network it is being offered would send an
    // agent into a retry loop it cannot escape.
    expect(text).not.toContain("challenge.accepts.network");
  });
});

