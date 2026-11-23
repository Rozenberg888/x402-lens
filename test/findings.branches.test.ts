/**
 * Findings behaviour that mutation testing found unasserted.
 *
 * These are not new features. Each test covers a mutant that survived the
 * existing suite at 78% mutation score — meaning the code could be changed to
 * something wrong and every test still passed. The four areas below are the ones
 * where a silent change would produce a *misleading* diagnosis rather than no
 * diagnosis, which is the worse failure for a tool whose product is the
 * explanation.
 */

import { describe, expect, it } from "vitest";
import { diagnose, type Finding } from "@x402-lens/core";

const NETWORK = "eip155:84532";
const OTHER_NETWORK = "eip155:8453";
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

function challenge(overrides: Record<string, unknown> = {}) {
  return {
    x402Version: 2,
    resource: { url: "https://example.com/weather" },
    accepts: [
      {
        scheme: "exact",
        network: NETWORK,
        asset: ASSET,
        payTo: PAY_TO,
        amount: "1000",
        maxTimeoutSeconds: 60,
        ...overrides,
      },
    ],
  } as never;
}

describe("findings: ordering", () => {
  it("returns errors before warnings, and warnings before info", () => {
    // One input that must produce findings at different severities. Errors sort
    // first because an operator reading a log top-down should see what blocked
    // the payment before what merely looked odd.
    const findings = diagnose({
      paymentRequired: challenge({ network: "not-a-network" }),
      paymentPayload: {
        x402Version: 2,
        // A network the challenge does not offer, so `network_not_offered`
        // also fires — a different severity from the CAIP-2 error.
        accepted: { scheme: "exact", network: OTHER_NETWORK },
      } as never,
      now: Date.now(),
    });

    expect(findings.length).toBeGreaterThan(1);

    const rank = { error: 0, warn: 1, info: 2 } as const;
    const ranks = findings.map(finding => rank[finding.severity]);
    const sorted = [...ranks].sort((a, b) => a - b);
    expect(ranks).toEqual(sorted);
  });

  it("breaks severity ties by code, so the order is stable", () => {
    // This input matters: `checkNetwork` runs before `checkAmount`, so the rules
    // emit `network_not_offered` then `amount_not_atomic`. Sorted by code,
    // `amount_not_atomic` must come first. Without the comparator the array
    // stays in emission order and this fails — which is what makes the sort
    // provable at all, since the rules happen to list errors before warnings.
    const findings = diagnose({
      paymentRequired: {
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
            asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
            payTo: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
            amount: "1.5",
            maxTimeoutSeconds: 60,
          },
        ],
      } as never,
      paymentPayload: {
        x402Version: 2,
        accepted: {
          scheme: "exact",
          network: "solana:Other",
          asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
          payTo: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
          amount: "1.5",
        },
      } as never,
      now: Date.now(),
    });

    const codes = findings.map(finding => finding.code);
    // Both must be present, or the assertion below would pass on an empty list.
    expect(codes).toContain("amount_not_atomic");
    expect(codes).toContain("network_not_offered");
    expect(codes.indexOf("amount_not_atomic")).toBeLessThan(
      codes.indexOf("network_not_offered"),
    );
  });

  it("orders an error before a warning regardless of which rule emitted it", () => {
    // `checkAmount` (error) runs before `checkEip712Domain` (warning), so this
    // input cannot distinguish sorted from unsorted. It still pins the property
    // a reader relies on: scanning top-down hits blockers first.
    const findings = diagnose({
      paymentRequired: {
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: "eip155:84532",
            asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
            amount: "1.5",
            maxTimeoutSeconds: 60,
          },
        ],
      } as never,
      now: Date.now(),
    });

    const severities = findings.map(finding => finding.severity);
    expect(severities).toContain("error");
    expect(severities).toContain("warn");
    expect(severities.lastIndexOf("error")).toBeLessThan(severities.indexOf("warn"));
  });
});

describe("findings: accepting the payload's chosen offer", () => {
  it("stays silent when the payload chose an offer the challenge advertised", () => {
    const findings = diagnose({
      paymentRequired: challenge(),
      paymentPayload: {
        x402Version: 2,
        accepted: { scheme: "exact", network: NETWORK, asset: ASSET, payTo: PAY_TO, amount: "1000" },
      } as never,
      now: Date.now(),
    });

    // The happy path must produce no network or amount findings: a false
    // positive here trains users to ignore the tool.
    expect(findings.filter(finding => finding.code === "network_not_offered")).toHaveLength(0);
    expect(findings.filter(finding => finding.code === "amount_mismatch")).toHaveLength(0);
  });

  it("reports network_not_offered when the payload chose a different network", () => {
    const findings = diagnose({
      paymentRequired: challenge(),
      paymentPayload: {
        x402Version: 2,
        accepted: { scheme: "exact", network: OTHER_NETWORK, asset: ASSET, payTo: PAY_TO, amount: "1000" },
      } as never,
      now: Date.now(),
    });

    expect(findings.some(finding => finding.code === "network_not_offered")).toBe(true);
  });

  it("does not guess an offer when the challenge lists several and the payload chose none", () => {
    const multi = {
      x402Version: 2,
      resource: { url: "https://example.com/weather" },
      accepts: [
        { scheme: "exact", network: NETWORK, asset: ASSET, payTo: PAY_TO, amount: "1000" },
        { scheme: "exact", network: OTHER_NETWORK, asset: ASSET, payTo: PAY_TO, amount: "1000" },
      ],
    } as never;

    const findings = diagnose({ paymentRequired: multi, now: Date.now() });

    // With two offers and no choice recorded, comparing against either one
    // would be a guess. The findings must not invent a mismatch from a guess.
    expect(findings.filter(finding => finding.code === "amount_mismatch")).toHaveLength(0);
  });
});

describe("findings: authorization time window", () => {
  const nowSeconds = 1_700_000_000;

  function payloadWith(authorization: Record<string, string>) {
    return {
      x402Version: 2,
      accepted: { scheme: "exact", network: NETWORK, asset: ASSET, payTo: PAY_TO, amount: "1000" },
      payload: {
        signature: `0x${"ab".repeat(65)}`,
        authorization: {
          from: PAY_TO,
          to: PAY_TO,
          value: "1000",
          nonce: `0x${"cd".repeat(32)}`,
          validAfter: "0",
          validBefore: "9999999999",
          ...authorization,
        },
      },
    } as never;
  }

  it("flags an authorization that has already expired", () => {
    const findings = diagnose({
      paymentRequired: challenge(),
      paymentPayload: payloadWith({ validBefore: String(nowSeconds - 1) }),
      now: nowSeconds * 1000,
    });

    expect(findings.some(finding => finding.code === "authorization_expired")).toBe(true);
  });

  it("does not flag an authorization that expires later", () => {
    const findings = diagnose({
      paymentRequired: challenge(),
      paymentPayload: payloadWith({ validBefore: String(nowSeconds + 3600) }),
      now: nowSeconds * 1000,
    });

    expect(findings.some(finding => finding.code === "authorization_expired")).toBe(false);
  });

  it("flags an authorization that is not valid yet", () => {
    const findings = diagnose({
      paymentRequired: challenge(),
      paymentPayload: payloadWith({ validAfter: String(nowSeconds + 3600) }),
      now: nowSeconds * 1000,
    });

    expect(findings.some(finding => finding.code === "authorization_not_yet_valid")).toBe(true);
  });

  it("does not flag an authorization whose window is currently open", () => {
    const findings = diagnose({
      paymentRequired: challenge(),
      paymentPayload: payloadWith({
        validAfter: String(nowSeconds - 60),
        validBefore: String(nowSeconds + 60),
      }),
      now: nowSeconds * 1000,
    });

    expect(findings.some(finding => finding.code === "authorization_expired")).toBe(false);
    expect(findings.some(finding => finding.code === "authorization_not_yet_valid")).toBe(false);
  });

  it("treats the exact expiry second as expired", () => {
    // The boundary is the interesting mutant: `<` versus `<=` changes whether a
    // payment valid "until now" is reported as expired.
    const findings = diagnose({
      paymentRequired: challenge(),
      paymentPayload: payloadWith({ validBefore: String(nowSeconds) }),
      now: nowSeconds * 1000,
    });

    expect(findings.some(finding => finding.code === "authorization_expired")).toBe(true);
  });
});

describe("findings: input shapes that must not throw", () => {
  it("returns findings for an empty input rather than throwing", () => {
    expect(() => diagnose({ now: Date.now() })).not.toThrow();
    const findings: Finding[] = diagnose({ now: Date.now() });
    expect(Array.isArray(findings)).toBe(true);
  });

  it("survives a challenge with an empty accepts array", () => {
    const findings = diagnose({
      paymentRequired: { x402Version: 2, accepts: [] } as never,
      now: Date.now(),
    });
    expect(Array.isArray(findings)).toBe(true);
  });

  it("survives a payload with no accepted entry", () => {
    const findings = diagnose({
      paymentRequired: challenge(),
      paymentPayload: { x402Version: 2 } as never,
      now: Date.now(),
    });
    expect(Array.isArray(findings)).toBe(true);
  });
});
