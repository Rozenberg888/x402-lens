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

describe("validatePaymentRequired field-level rules", () => {
  // Mutation testing showed these branches were never exercised: the original
  // tests removed whole objects rather than individual fields, so a validator
  // that silently accepted a missing `scheme` or an empty `payTo` stayed green.
  const withAccept = (overrides: Record<string, unknown>) =>
    ({
      x402Version: 2,
      resource: { url: "https://example.com/x" },
      accepts: [
        {
          scheme: "exact",
          network: "eip155:84532",
          amount: "10000",
          asset: "0x0",
          payTo: "0x0",
          maxTimeoutSeconds: 60,
          ...overrides,
        },
      ],
    }) as unknown as WirePaymentRequired;

  it("requires a non-empty scheme", () => {
    expect(validatePaymentRequired(withAccept({ scheme: "" })).some(i => i.field === "accepts[0].scheme")).toBe(true);
    expect(validatePaymentRequired(withAccept({ scheme: undefined })).some(i => i.field === "accepts[0].scheme")).toBe(true);
    expect(validatePaymentRequired(withAccept({ scheme: 42 })).some(i => i.field === "accepts[0].scheme")).toBe(true);
  });

  it("requires a non-empty asset", () => {
    expect(validatePaymentRequired(withAccept({ asset: "" })).some(i => i.field === "accepts[0].asset")).toBe(true);
    expect(validatePaymentRequired(withAccept({ asset: undefined })).some(i => i.field === "accepts[0].asset")).toBe(true);
  });

  it("requires a non-empty payTo", () => {
    expect(validatePaymentRequired(withAccept({ payTo: "" })).some(i => i.field === "accepts[0].payTo")).toBe(true);
    expect(validatePaymentRequired(withAccept({ payTo: undefined })).some(i => i.field === "accepts[0].payTo")).toBe(true);
  });

  it("rejects a non-positive or non-numeric timeout", () => {
    for (const value of [0, -1, "60", undefined, null]) {
      expect(
        validatePaymentRequired(withAccept({ maxTimeoutSeconds: value })).some(
          i => i.field === "accepts[0].maxTimeoutSeconds",
        ),
      ).toBe(true);
    }
  });

  it("rejects an accept entry that is not an object", () => {
    const issues = validatePaymentRequired({
      x402Version: 2,
      resource: { url: "https://example.com/x" },
      accepts: [null],
    } as unknown as WirePaymentRequired);
    expect(issues.some(i => i.field === "accepts[0]")).toBe(true);
  });

  it("rejects an empty resource URL", () => {
    const issues = validatePaymentRequired({
      x402Version: 2,
      resource: { url: "" },
      accepts: [],
    } as unknown as WirePaymentRequired);
    expect(issues.some(i => i.field === "resource.url")).toBe(true);
  });

  it("reports every broken field rather than stopping at the first", () => {
    // A validator that returned early would hide two thirds of a broken config.
    const issues = validatePaymentRequired(
      withAccept({ scheme: "", asset: "", payTo: "", maxTimeoutSeconds: 0 }),
    );
    const fields = issues.map(issue => issue.field);
    expect(fields).toContain("accepts[0].scheme");
    expect(fields).toContain("accepts[0].asset");
    expect(fields).toContain("accepts[0].payTo");
    expect(fields).toContain("accepts[0].maxTimeoutSeconds");
  });
});

describe("validatePayloadAgainstChallenge edge cases", () => {
  it("flags a payload that declares a version other than 2", () => {
    const issues = validatePayloadAgainstChallenge(paymentPayload({ x402Version: 1 }), challenge());
    expect(issues.some(issue => issue.field === "payment.x402Version")).toBe(true);
  });

  it("flags a payload with no accepted requirement", () => {
    const { accepted: _omitted, ...withoutAccepted } = paymentPayload();
    const issues = validatePayloadAgainstChallenge(withoutAccepted, challenge());
    expect(issues.some(issue => issue.field === "payment.accepted")).toBe(true);
  });

  it("accepts a payload that echoes the second offered network", () => {
    // The counterpart to the accepts[0] bug: matching must consider every offer.
    const other = {
      scheme: "exact",
      network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      amount: "10000",
      asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      payTo: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      maxTimeoutSeconds: 60,
    };
    const twoNetworks = challenge({
      accepts: [...(challenge().accepts ?? []), other],
    });
    const issues = validatePayloadAgainstChallenge(paymentPayload({ accepted: other }), twoNetworks);
    expect(issues).toEqual([]);
  });
});

describe("checkCors", () => {
  it("passes when all three headers are exposed", () => {
    const report = checkCors({
      "access-control-expose-headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE",
      "access-control-allow-headers": "content-type, PAYMENT-SIGNATURE",
      "access-control-allow-origin": "*",
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
      "access-control-allow-origin": "*",
    });
    expect(report.issues).toEqual([]);
  });

  it("does not accept a wildcard as covering the payment headers", () => {
    const report = checkCors({
      "access-control-expose-headers": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-origin": "*",
    });
    // A literal `*` does not cover these names on a credentialed request.
    expect(report.issues).toHaveLength(2);
  });

  it("flags missing Access-Control-Allow-Origin when payment CORS is otherwise set", () => {
    const report = checkCors({
      "access-control-expose-headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE",
      "access-control-allow-headers": "PAYMENT-SIGNATURE",
    });
    expect(report.issues.some(issue => issue.field === "Access-Control-Allow-Origin")).toBe(true);
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
