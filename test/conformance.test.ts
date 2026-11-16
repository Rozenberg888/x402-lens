/**
 * Conformance and CORS checks, exercised against the live middleware output.
 *
 * The findings engine reads captured JSON; these tests prove the validator
 * agrees with what the real SDK emits, which is the only assertion that
 * actually prevents drift from the specification.
 */

import { describe, expect, it } from "vitest";
import {
  checkCors,
  validatePaymentRequired,
  validatePayloadAgainstChallenge,
  type WirePaymentRequired,
} from "@x402-lens/core";
import { challenge, paymentPayload } from "./fixtures";

describe("validatePaymentRequired", () => {
  it("accepts a conformant challenge", () => {
    expect(validatePaymentRequired(challenge())).toEqual([]);
  });

  it("requires x402Version to be 2", () => {
    const issues = validatePaymentRequired(challenge({ x402Version: 1 }));
    expect(issues.some(issue => issue.field === "x402Version")).toBe(true);
  });

  it("requires resource.url", () => {
    const issues = validatePaymentRequired(challenge({ resource: {} }));
    expect(issues.some(issue => issue.field === "resource.url")).toBe(true);
  });

  it("requires at least one accept", () => {
    const issues = validatePaymentRequired(challenge({ accepts: [] }));
    expect(issues.some(issue => issue.field === "accepts")).toBe(true);
  });

  it("rejects a non-CAIP-2 network", () => {
    const issues = validatePaymentRequired({
      ...challenge(),
      accepts: [
        {
          scheme: "exact",
          network: "base-sepolia",
          amount: "10000",
          asset: "0x0",
          payTo: "0x0",
          maxTimeoutSeconds: 60,
        },
      ],
    });
    expect(issues.some(issue => issue.field === "accepts[0].network")).toBe(true);
  });

  it("rejects a decimal amount", () => {
    const issues = validatePaymentRequired({
      ...challenge(),
      accepts: [
        {
          scheme: "exact",
          network: "eip155:84532",
          amount: "0.01",
          asset: "0x0",
          payTo: "0x0",
          maxTimeoutSeconds: 60,
        },
      ],
    });
    expect(issues.some(issue => issue.field === "accepts[0].amount")).toBe(true);
  });

  it("rejects a missing maxTimeoutSeconds", () => {
    const issues = validatePaymentRequired({
      x402Version: 2,
      resource: { url: "https://example.com/x" },
      accepts: [
        { scheme: "exact", network: "eip155:84532", amount: "10000", asset: "0x0", payTo: "0x0" },
      ],
    });
    expect(issues.some(issue => issue.field === "accepts[0].maxTimeoutSeconds")).toBe(true);
  });

  it("rejects a non-object", () => {
    expect(validatePaymentRequired([])[0]?.field).toBe("$");
    expect(validatePaymentRequired(null)[0]?.field).toBe("$");
  });
});

describe("validatePayloadAgainstChallenge", () => {
  it("accepts a payload that echoes an offered option", () => {
    expect(validatePayloadAgainstChallenge(paymentPayload(), challenge())).toEqual([]);
  });

  it("rejects a payload for a network the challenge does not offer", () => {
    const payload = paymentPayload({
      accepted: {
        scheme: "exact",
        network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        amount: "10000",
        asset: "0x0",
        payTo: "0x0",
      },
    });
    const issues = validatePayloadAgainstChallenge(payload, challenge());
    expect(issues.some(issue => issue.field === "payment.accepted")).toBe(true);
  });
});

describe("checkCors", () => {
  it("passes when all three headers are exposed", () => {
    const report = checkCors({
      "access-control-expose-headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE",
      "access-control-allow-headers": "content-type, PAYMENT-SIGNATURE",
    });
    expect(report.issues).toEqual([]);
    expect(report.exposesPaymentRequired).toBe(true);
    expect(report.allowsPaymentSignature).toBe(true);
  });

  it("reports the missing exposure headers", () => {
    const report = checkCors({});
    expect(report.issues).toHaveLength(2);
    expect(report.issues[0]?.problem).toContain("PAYMENT-REQUIRED");
    expect(report.issues[1]?.problem).toContain("PAYMENT-SIGNATURE");
  });

  it("is case-insensitive", () => {
    const report = checkCors({
      "access-control-expose-headers": "payment-required, payment-response",
      "access-control-allow-headers": "payment-signature",
    });
    expect(report.issues).toEqual([]);
  });

  it("does not accept a wildcard as covering the payment headers", () => {
    const report = checkCors({
      "access-control-expose-headers": "*",
      "access-control-allow-headers": "*",
    });
    // A literal `*` does not cover these names on a credentialed request.
    expect(report.issues).toHaveLength(2);
  });
});

describe("challenge mirrored into the body", () => {
  it("keeps every field a client needs to build a payment", () => {
    const body = {
      x402Version: 2,
      accepts: challenge().accepts,
    } as WirePaymentRequired;
    expect(validatePaymentRequired({ ...body, resource: { url: "https://x" } })).toEqual([]);
  });
});
