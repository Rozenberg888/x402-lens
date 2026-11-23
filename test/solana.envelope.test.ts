/**
 * What can be checked about a Solana payload without the Solana SDK.
 *
 * `core` deliberately does not decode the wire transaction: instruction-level
 * parsing needs the Solana program definitions, and a wrong guess about a
 * transfer is worse than an honest "not checked". That decision stands.
 *
 * But "we do not decode it" quietly became "we do not look at it at all", and the
 * two most common failures are visible without decoding anything:
 *
 * - `transaction` is not valid base64, so no client can construct a payment
 *   from it. This happens when a client sends the raw bytes, a JSON array, or a
 *   truncated string, and the facilitator answers with a generic invalid_reason
 *   that says nothing about encoding.
 * - The decoded bytes are not a plausible Solana transaction: too short to hold
 *   signatures and a message header. A 4-byte string decodes "successfully"
 *   from base64 and is not a payment.
 *
 * Neither check needs to understand a transfer instruction, so neither can be
 * wrong in the way instruction parsing can. That is the line: check the envelope,
 * never guess the contents.
 */

import { describe, expect, it } from "vitest";
import { diagnose } from "@x402-lens/core";

const SVM = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const PAY_TO = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

function challenge(): Record<string, unknown> {
  return {
    x402Version: 2,
    resource: { url: "https://example.com/weather" },
    accepts: [
      {
        scheme: "exact",
        network: SVM,
        asset: MINT,
        payTo: PAY_TO,
        amount: "1000",
        maxTimeoutSeconds: 60,
      },
    ],
  };
}

function payload(transaction: unknown): Record<string, unknown> {
  return {
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: SVM,
      asset: MINT,
      payTo: PAY_TO,
      amount: "1000",
    },
    payload: { transaction },
  };
}

describe("solana: the size boundary", () => {
  it("rejects 99 bytes and accepts 100", () => {
    // The boundary is the whole rule. Testing 2 bytes and 400 bytes only proves
    // "very short fails, long passes" — an off-by-one or a changed comparison
    // would survive that.
    const short = Buffer.alloc(99, 1).toString("base64");
    const atLimit = Buffer.alloc(100, 1).toString("base64");

    const shortFindings = diagnose({
      paymentRequired: challenge() as never,
      paymentPayload: payload(short) as never,
      now: Date.now(),
    });
    expect(shortFindings.some(item => item.code === "transaction_too_short")).toBe(true);

    const limitFindings = diagnose({
      paymentRequired: challenge() as never,
      paymentPayload: payload(atLimit) as never,
      now: Date.now(),
    });
    // Exactly at the minimum is a transaction-shaped envelope; anything at or
    // above it must pass, or a real payment of the smallest legal size is
    // reported as broken.
    expect(limitFindings.some(item => item.code === "transaction_too_short")).toBe(false);
  });
});

describe("solana: base64 acceptance", () => {
  it("accepts padded base64", () => {
    // 5 bytes is not a multiple of 3, so every standard encoder emits one `=`.
    const padded = Buffer.from("hello").toString("base64");
    expect(padded).toContain("=");

    const findings = diagnose({
      paymentRequired: challenge() as never,
      paymentPayload: payload(padded) as never,
      now: Date.now(),
    });
    // 5 bytes: too short, but the encoding itself must not be blamed.
    expect(findings.some(item => item.code === "transaction_not_base64")).toBe(false);
  });

  it("accepts unpadded base64", () => {
    // Stripping padding is legal and decodes identically. Requiring it would be
    // a false "not base64" on a payload a client legitimately produced.
    const unpadded = Buffer.alloc(100, 3).toString("base64").replace(/=+$/, "");

    const findings = diagnose({
      paymentRequired: challenge() as never,
      paymentPayload: payload(unpadded) as never,
      now: Date.now(),
    });
    expect(findings.some(item => item.code === "transaction_not_base64")).toBe(false);
  });

  it("rejects a string that looks like base64 but does not round-trip", () => {
    // Right alphabet, right length, wrong trailing bits: decoding it silently
    // produces different bytes, so it is not a transaction anyone can verify.
    // This is the case the round-trip exists for and the regex alone misses.
    const notReallyBase64 = "A".repeat(100) + "B";

    const findings = diagnose({
      paymentRequired: challenge() as never,
      paymentPayload: payload(notReallyBase64) as never,
      now: Date.now(),
    });

    // Either code is defensible — it is not valid base64, and it is short after
    // a lossy decode — but silence is not: the client sent something the
    // facilitator will reject with no explanation.
    const named =
      findings.some(item => item.code === "transaction_not_base64") ||
      findings.some(item => item.code === "transaction_too_short");
    expect(named).toBe(true);
  });
});

describe("solana: missing payload", () => {
  it("says nothing when the payload object is absent entirely", () => {
    // A payload with no `payload` key is a different defect; reporting a
    // transaction problem here would be a second finding for one mistake.
    const findings = diagnose({
      paymentRequired: challenge() as never,
      paymentPayload: {
        x402Version: 2,
        accepted: { scheme: "exact", network: SVM, asset: MINT, payTo: PAY_TO, amount: "1000" },
      } as never,
      now: Date.now(),
    });

    expect(findings.some(item => item.code === "transaction_not_base64")).toBe(false);
    expect(findings.some(item => item.code === "transaction_too_short")).toBe(false);
  });
});

describe("solana: transaction encoding", () => {
  it("flags a transaction that is not base64", () => {
    const findings = diagnose({
      paymentRequired: challenge() as never,
      paymentPayload: payload("not base64 at all !!!") as never,
      now: Date.now(),
    });

    const finding = findings.find(item => item.code === "transaction_not_base64");
    expect(finding).toBeDefined();
    // A generic invalid_reason from the facilitator is what the user sees today;
    // naming the encoding is the difference between a five-minute fix and a day.
    expect(finding?.field).toBe("payment.payload.transaction");
  });

  it("names the encoding in the fix, not just the problem", () => {
    const findings = diagnose({
      paymentRequired: challenge() as never,
      paymentPayload: payload("%%%not-base64%%%") as never,
      now: Date.now(),
    });

    const finding = findings.find(item => item.code === "transaction_not_base64");
    expect(finding?.fix.toLowerCase()).toContain("base64");
  });

  it("accepts a plausible base64 transaction without complaint", () => {
    // 200 zero bytes: not a valid payment, but a well-formed envelope. The
    // envelope check must not fire on it — guessing beyond this is exactly what
    // the design refuses to do.
    const bytes = Buffer.alloc(200, 0);
    const findings = diagnose({
      paymentRequired: challenge() as never,
      paymentPayload: payload(bytes.toString("base64")) as never,
      now: Date.now(),
    });

    expect(findings.some(item => item.code === "transaction_not_base64")).toBe(false);
  });

  it("flags a transaction too short to be a signed message", () => {
    // Decodes fine, cannot be a transaction: a signature alone is 64 bytes.
    const findings = diagnose({
      paymentRequired: challenge() as never,
      paymentPayload: payload(Buffer.from("hi").toString("base64")) as never,
      now: Date.now(),
    });

    const finding = findings.find(item => item.code === "transaction_too_short");
    expect(finding).toBeDefined();
    expect(finding?.problem).toMatch(/too short|64 bytes/i);
  });

  it("reports a short unpadded string as too short, not as bad encoding", () => {
    // `abc` is legal unpadded base64 — two bytes. It must not be called bad
    // encoding, because the encoding is fine; the content is what is wrong.
    // Requiring length % 4 would have produced exactly that false finding on a
    // real (if malformed) payload.
    const findings = diagnose({
      paymentRequired: challenge() as never,
      paymentPayload: payload("abc") as never,
      now: Date.now(),
    });

    expect(findings.some(item => item.code === "transaction_not_base64")).toBe(false);
    expect(findings.some(item => item.code === "transaction_too_short")).toBe(true);
  });

  it("accepts a real transaction-sized blob without complaint", () => {
    // A 400-byte body is the shape of a real signed transaction; the envelope
    // checks must stay silent on it and leave the content alone.
    const findings = diagnose({
      paymentRequired: challenge() as never,
      paymentPayload: payload(Buffer.alloc(400, 7).toString("base64")) as never,
      now: Date.now(),
    });

    expect(findings.some(item => item.code === "transaction_not_base64")).toBe(false);
    expect(findings.some(item => item.code === "transaction_too_short")).toBe(false);
  });

  it("does not complain about a payload with no transaction at all", () => {
    // A missing field is a different defect, already covered by the payload
    // shape checks; reporting it twice trains people to ignore duplicates.
    const findings = diagnose({
      paymentRequired: challenge() as never,
      paymentPayload: {
        x402Version: 2,
        accepted: { scheme: "exact", network: SVM, asset: MINT, payTo: PAY_TO, amount: "1000" },
        payload: {},
      } as never,
      now: Date.now(),
    });

    expect(findings.some(item => item.code === "transaction_not_base64")).toBe(false);
    expect(findings.some(item => item.code === "transaction_too_short")).toBe(false);
  });

  it("leaves EVM payloads alone", () => {
    // The rule must be scoped to the Solana namespace: an EVM payload has no
    // `transaction` field at all, and firing here would be noise on every EVM
    // payment.
    const findings = diagnose({
      paymentRequired: {
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: "eip155:84532",
            asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
            amount: "1000",
            maxTimeoutSeconds: 60,
          },
        ],
      } as never,
      paymentPayload: {
        x402Version: 2,
        accepted: {
          scheme: "exact",
          network: "eip155:84532",
          asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
          amount: "1000",
        },
        payload: { signature: `0x${"ab".repeat(65)}`, authorization: {} },
      } as never,
      now: Date.now(),
    });

    expect(findings.some(item => item.code === "transaction_not_base64")).toBe(false);
    expect(findings.some(item => item.code === "transaction_too_short")).toBe(false);
  });
});
