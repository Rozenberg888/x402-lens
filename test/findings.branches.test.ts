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
    const findings = diagnose({
      paymentRequired: challenge({ network: "not-a-network" }),
      now: Date.now(),
    });

    const sameRank = findings.filter(finding => finding.severity === "error");
    if (sameRank.length < 2) return; // Nothing to order; the other test covers the sort.

    const codes = sameRank.map(finding => finding.code);
    const sorted = [...codes].sort((a, b) => a.localeCompare(b));
    expect(codes).toEqual(sorted);
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
