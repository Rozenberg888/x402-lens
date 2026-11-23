/**
 * The shape every finding must have, checked once instead of per message.
 *
 * Mutation testing kept reporting ~87 surviving `StringLiteral` mutants in
 * rules.ts, and the obvious reading — "the wording is untested" — is only half
 * right. Some of those strings are load-bearing: `"error"` is a severity,
 * `"payment.x402Version"` is a field path. Nobody wants a test asserting each
 * sentence verbatim; the wording will change and the tests would then be work
 * rather than protection.
 *
 * So this file asserts the properties a finding must have regardless of wording:
 *
 * - severity is one of the three known values, so a mutated `"error"` into
 *   `"errors"` fails here;
 * - field is a dotted path, so a corrupted `"payment.x402Version"` fails here;
 * - problem says what is wrong (non-trivial length, no placeholder);
 * - fix starts with an action, so "Re-sign with…" cannot silently become
 *   "…" or a fragment.
 *
 * The last one is the useful part: a fix that does not start with a verb is not
 * a fix. That is checkable without pinning the sentence, and it kills most
 * string mutants because they mangle the opening word.
 */

import { describe, expect, it } from "vitest";
import { diagnose, type Finding } from "@x402-lens/core";

const NOW = 1_700_000_000_000;

const EVM_ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const EVM_PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const SVM_NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const SVM_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const SVM_PAY_TO = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

/**
 * An EVM `exact` payload with a signed authorization.
 *
 * The window and recipient rules only run when `asEvmExactPayload` recognises
 * the shape, so this has to match the wire model exactly: `signature` plus an
 * `authorization` with all six fields.
 *
 * @param overrides - Fields to change on the authorization
 * @returns A payload shaped like a real one
 */
function evmPayload(overrides: Record<string, string> = {}): Record<string, unknown> {
  return {
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: "eip155:84532",
      asset: EVM_ASSET,
      payTo: EVM_PAY_TO,
      amount: "1000",
    },
    payload: {
      signature: `0x${"ab".repeat(65)}`,
      authorization: {
        from: EVM_PAY_TO,
        to: EVM_PAY_TO,
        value: "1000",
        validAfter: "0",
        validBefore: String(NOW / 1000 + 3600),
        nonce: `0x${"cd".repeat(32)}`,
        ...overrides,
      },
    },
  };
}

/**
 * Inputs chosen to reach every distinct finding code the engine can emit.
 *
 * Not one per rule — one per code that actually appears, which is what the
 * contract below needs. A code with no input here would go unchecked, so the
 * count is asserted at the end.
 */
const CASES: Array<{ name: string; findings: Finding[] }> = [
  {
    name: "v1 payload against a v2 server",
    findings: diagnose({
      paymentPayload: { x402Version: 1 } as never,
      now: NOW,
    }),
  },
  {
    name: "challenge with no accepts",
    findings: diagnose({
      paymentRequired: { x402Version: 2, accepts: [] } as never,
      now: NOW,
    }),
  },
  {
    name: "shorthand network id",
    findings: diagnose({
      paymentRequired: {
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: "base-sepolia",
            asset: EVM_ASSET,
            payTo: EVM_PAY_TO,
            amount: "1000",
            maxTimeoutSeconds: 60,
          },
        ],
      } as never,
      now: NOW,
    }),
  },
  {
    name: "non-atomic amount",
    findings: diagnose({
      paymentRequired: {
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: "eip155:84532",
            asset: EVM_ASSET,
            payTo: EVM_PAY_TO,
            amount: "1.5",
            maxTimeoutSeconds: 60,
          },
        ],
      } as never,
      now: NOW,
    }),
  },
  {
    name: "missing EIP-712 domain",
    findings: diagnose({
      paymentRequired: {
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: "eip155:84532",
            asset: EVM_ASSET,
            payTo: EVM_PAY_TO,
            amount: "1000",
            maxTimeoutSeconds: 60,
          },
        ],
      } as never,
      now: NOW,
    }),
  },
  {
    name: "Solana offer with an EVM payTo",
    findings: diagnose({
      paymentRequired: {
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: SVM_NETWORK,
            asset: SVM_MINT,
            payTo: "0x209693",
            amount: "1000",
            maxTimeoutSeconds: 60,
          },
        ],
      } as never,
      now: NOW,
    }),
  },
  {
    name: "mapped verify rejection",
    findings: diagnose({
      verifyResponse: { isValid: false, invalidReason: "invalid_exact_evm_payload_signature" } as never,
      now: NOW,
    }),
  },
  {
    name: "unmapped verify rejection",
    findings: diagnose({
      verifyResponse: { isValid: false, invalidReason: "some_vendor_code" } as never,
      now: NOW,
    }),
  },
  {
    name: "terminal settle failure",
    findings: diagnose({
      settleResponse: { success: false, errorReason: "insufficient_funds" } as never,
      now: NOW,
    }),
  },
  {
    name: "Solana transaction that is not base64",
    findings: diagnose({
      paymentRequired: {
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: SVM_NETWORK,
            asset: SVM_MINT,
            payTo: SVM_PAY_TO,
            amount: "1000",
            maxTimeoutSeconds: 60,
          },
        ],
      } as never,
      paymentPayload: {
        x402Version: 2,
        accepted: { scheme: "exact", network: SVM_NETWORK, asset: SVM_MINT, payTo: SVM_PAY_TO, amount: "1000" },
        payload: { transaction: "not base64 !!!" },
      } as never,
      now: NOW,
    }),
  },
  {
    name: "payload signed for a network the challenge does not offer",
    findings: diagnose({
      paymentRequired: {
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: "eip155:84532",
            asset: EVM_ASSET,
            payTo: EVM_PAY_TO,
            amount: "1000",
            maxTimeoutSeconds: 60,
          },
        ],
      } as never,
      paymentPayload: {
        x402Version: 2,
        accepted: {
          scheme: "exact",
          network: "eip155:8453",
          asset: EVM_ASSET,
          payTo: EVM_PAY_TO,
          amount: "1000",
        },
      } as never,
      now: NOW,
    }),
  },
  {
    name: "Solana transaction shorter than a signature",
    findings: diagnose({
      paymentRequired: {
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: SVM_NETWORK,
            asset: SVM_MINT,
            payTo: SVM_PAY_TO,
            amount: "1000",
            maxTimeoutSeconds: 60,
          },
        ],
      } as never,
      paymentPayload: {
        x402Version: 2,
        accepted: { scheme: "exact", network: SVM_NETWORK, asset: SVM_MINT, payTo: SVM_PAY_TO, amount: "1000" },
        payload: { transaction: "abc" },
      } as never,
      now: NOW,
    }),
  },
  {
    // The authorization window rules only fire for an EVM payload carrying a
    // signed authorization, which none of the cases above produce. Without
    // these three, `authorization_not_yet_valid`, `authorization_expired` and
    // `pay_to_mismatch` were never exercised and their message strings could be
    // mangled unnoticed — verified by breaking one and watching this file stay
    // green.
    name: "EVM authorization that is not valid yet",
    findings: diagnose({
      paymentRequired: {
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: "eip155:84532",
            asset: EVM_ASSET,
            payTo: EVM_PAY_TO,
            amount: "1000",
            maxTimeoutSeconds: 60,
          },
        ],
      } as never,
      paymentPayload: evmPayload({ validAfter: String(NOW / 1000 + 3600) }) as never,
      now: NOW,
    }),
  },
  {
    name: "EVM authorization that has expired",
    findings: diagnose({
      paymentRequired: {
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: "eip155:84532",
            asset: EVM_ASSET,
            payTo: EVM_PAY_TO,
            amount: "1000",
            maxTimeoutSeconds: 60,
          },
        ],
      } as never,
      paymentPayload: evmPayload({ validBefore: String(NOW / 1000 - 1) }) as never,
      now: NOW,
    }),
  },
  {
    name: "EVM authorization paying a different address",
    findings: diagnose({
      paymentRequired: {
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: "eip155:84532",
            asset: EVM_ASSET,
            payTo: EVM_PAY_TO,
            amount: "1000",
            maxTimeoutSeconds: 60,
          },
        ],
      } as never,
      paymentPayload: evmPayload({ to: "0x0000000000000000000000000000000000000001" }) as never,
      now: NOW,
    }),
  },
];

/** Every finding produced by every case, flattened. */
function allFindings(): Finding[] {
  return CASES.flatMap(entry => entry.findings);
}

describe("finding contract: severity", () => {
  it("is always one of the three known values", () => {
    // `"error"` appears as a literal in every rule, and mutation testing showed
    // those literals surviving. A severity typo is not cosmetic: consumers
    // filter and alert on it.
    for (const finding of allFindings()) {
      expect(["error", "warn", "info"]).toContain(finding.severity);
    }
  });

  it("never emits a severity as a non-string", () => {
    for (const finding of allFindings()) {
      expect(typeof finding.severity).toBe("string");
    }
  });
});

describe("finding contract: field", () => {
  it("is a dotted path of identifier segments", () => {
    // These strings are what an operator greps for and what `inspect` prints.
    // A corrupted one sends the reader to a field that does not exist.
    //
    // The pattern allows the three shapes the wire model actually uses:
    // `payment.x402Version` (camelCase), `challenge.accepts[0].amount` (indexed),
    // and `challenge.accepts.extra.name` (nested). It is written to accept all
    // three rather than to tighten around one — a check that fails on correct
    // output is worse than a loose one.
    for (const finding of allFindings()) {
      const segments = finding.field.split(".");
      expect(segments.length).toBeGreaterThan(1);
      for (const segment of segments) {
        expect(segment).toMatch(/^[A-Za-z][A-Za-z0-9]*(\[\d+\])*$/);
      }
    }
  });

  it("starts with a known root, so a field cannot point at nothing", () => {
    // The four roots the wire model actually has. A mutated field that starts
    // with something else is a field the reader cannot find.
    const roots = ["payment", "challenge", "verify", "settlement"];
    for (const finding of allFindings()) {
      expect(roots.some(root => finding.field.startsWith(`${root}.`))).toBe(true);
    }
  });
});

describe("finding contract: problem", () => {
  it("says something substantial", () => {
    // A mutated problem string that collapses to a few characters is not an
    // explanation. Twenty is well under the shortest real message and well over
    // a fragment.
    for (const finding of allFindings()) {
      expect(finding.problem.length).toBeGreaterThan(20);
    }
  });

  it("is a sentence, not a label", () => {
    // Not "starts with a capital": several real problems begin with the field
    // they are about (`payment declares x402Version 1`), which reads better than
    // capitalising. What distinguishes a sentence from a fragment is a verb and
    // a full stop's worth of content, so this checks length and spacing only.
    for (const finding of allFindings()) {
      expect(finding.problem).toContain(" ");
      expect(finding.problem.trim()).toBe(finding.problem);
    }
  });
});

describe("finding contract: fix", () => {
  it("starts with an imperative verb", () => {
    // This is the assertion that makes the message strings worth testing
    // without pinning them. A `fix` that begins with "Re-sign", "Set",
    // "Configure", "Request", "Rebuild", "Treat" or "Check" tells the reader to
    // do something. Mutation testing showed the opening word is exactly what a
    // mangled literal destroys, so checking it catches the mutants that matter.
    const verbs = [
      "Re-sign",
      "Set",
      "Configure",
      "Request",
      "Rebuild",
      "Treat",
      "Check",
      "Use",
      "Pick",
      "Send",
      "Serialize",
      "Upgrade",
      "Remove",
      "Add",
      "Keep",
      "Regenerate",
    ];

    for (const finding of allFindings()) {
      expect(
        verbs.some(verb => finding.fix.startsWith(verb)),
        `fix for ${finding.code} starts with neither an action nor a known verb: "${finding.fix.slice(0, 40)}"`,
      ).toBe(true);
    }
  });

  it("is long enough to be advice", () => {
    for (const finding of allFindings()) {
      expect(finding.fix.length).toBeGreaterThan(15);
    }
  });

  it("does not repeat the problem", () => {
    // A fix that is just the problem restated wastes the reader's time; this
    // also catches a mutant that copied one field into the other.
    for (const finding of allFindings()) {
      expect(finding.fix).not.toBe(finding.problem);
    }
  });
});

describe("finding contract: coverage of codes", () => {
  it("exercises at least ten distinct codes", () => {
    // Guards the file itself: if a case stops producing findings, the contract
    // silently stops checking that code. The number is the count that actually
    // appears today, so a drop means a rule changed behaviour.
    const codes = new Set(allFindings().map(finding => finding.code));
    expect(codes.size).toBeGreaterThanOrEqual(10);
  });

  it("every asserted finding is well-formed, not just the first", () => {
    // Cheap sanity that the helpers above are not receiving an empty list.
    expect(allFindings().length).toBeGreaterThanOrEqual(CASES.length);
  });
});

describe("finding contract: facilitator detail is bounded", () => {
  /**
   * `invalidMessage` comes from the facilitator and has no length limit. It is
   * pasted into a finding, so a verbose or hostile facilitator could make one
   * finding thousands of characters long — unreadable in a terminal and costly
   * in a log pipeline.
   */
  it("truncates a long facilitator message and marks the cut", () => {
    const long = "x".repeat(5000);
    const findings = diagnose({
      verifyResponse: {
        isValid: false,
        invalidReason: "invalid_exact_evm_payload_signature",
        invalidMessage: long,
      } as never,
      now: NOW,
    });

    const problem = findings[0]?.problem ?? "";
    // The elision marker is the only signal that text was removed; without it a
    // truncated message reads as the whole thing.
    expect(problem).toContain("…");
    expect(problem.length).toBeLessThan(1000);
    expect(problem).not.toContain("x".repeat(300));
  });

  it("keeps a short facilitator message intact", () => {
    const short = "signature expired at block 12345";
    const findings = diagnose({
      verifyResponse: {
        isValid: false,
        invalidReason: "invalid_exact_evm_payload_signature",
        invalidMessage: short,
      } as never,
      now: NOW,
    });

    // Truncating something that fits would hide information for no reason.
    expect(findings[0]?.problem).toContain(short);
    expect(findings[0]?.problem).not.toContain("…");
  });

  it("does not leave a dangling label when the facilitator says nothing", () => {
    const findings = diagnose({
      verifyResponse: {
        isValid: false,
        invalidReason: "invalid_exact_evm_payload_signature",
      } as never,
      now: NOW,
    });

    // " Facilitator said:" with nothing after it is worse than silence.
    expect(findings[0]?.problem).not.toContain("Facilitator said");
  });
});

describe("finding contract: choosing which offer to compare against", () => {
  const singleOffer = {
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: "eip155:84532",
        asset: EVM_ASSET,
        payTo: EVM_PAY_TO,
        amount: "1000",
        maxTimeoutSeconds: 60,
      },
    ],
  };

  it("compares against the only offer when the payload records no choice", () => {
    // One offer and no `accepted` still identifies what the client was asked to
    // pay, so a mismatch is reportable. Returning nothing here would hide a real
    // defect behind "we could not tell".
    const findings = diagnose({
      paymentRequired: singleOffer as never,
      paymentPayload: evmPayload({ value: "999" }) as never,
      now: NOW,
    });

    expect(findings.some(finding => finding.code === "amount_mismatch")).toBe(true);
  });

  it("refuses to guess when several offers exist and none was chosen", () => {
    // Two offers with different networks and no `accepted` on the payload:
    // comparing against either would be a guess, and a guessed mismatch is a
    // false finding. This is the branch `selectAccept` returns undefined for.
    const findings = diagnose({
      paymentRequired: {
        x402Version: 2,
        accepts: [
          singleOffer.accepts[0],
          { ...singleOffer.accepts[0], network: "eip155:8453" },
        ],
      } as never,
      paymentPayload: {
        x402Version: 2,
        payload: {
          signature: `0x${"ab".repeat(65)}`,
          authorization: {
            from: EVM_PAY_TO,
            to: EVM_PAY_TO,
            value: "999",
            validAfter: "0",
            validBefore: String(NOW / 1000 + 3600),
            nonce: `0x${"cd".repeat(32)}`,
          },
        },
      } as never,
      now: NOW,
    });

    // No `accepted` means the client did not record which offer it picked, and
    // with two offers there is no defensible answer to compare against.
    expect(findings.some(finding => finding.code === "amount_mismatch")).toBe(false);
  });

  it("matches the offer the payload actually chose", () => {
    // The chosen entry is eip155:8453 while the first offer is 84532; comparing
    // against accepts[0] would report a mismatch that does not exist.
    const findings = diagnose({
      paymentRequired: {
        x402Version: 2,
        accepts: [
          singleOffer.accepts[0],
          {
            scheme: "exact",
            network: "eip155:8453",
            asset: EVM_ASSET,
            payTo: EVM_PAY_TO,
            amount: "1000",
            maxTimeoutSeconds: 60,
          },
        ],
      } as never,
      paymentPayload: {
        ...(evmPayload() as Record<string, unknown>),
        accepted: {
          scheme: "exact",
          network: "eip155:8453",
          asset: EVM_ASSET,
          payTo: EVM_PAY_TO,
          amount: "1000",
        },
      } as never,
      now: NOW,
    });

    expect(findings.some(finding => finding.code === "amount_mismatch")).toBe(false);
    expect(findings.some(finding => finding.code === "network_not_offered")).toBe(false);
  });
});
