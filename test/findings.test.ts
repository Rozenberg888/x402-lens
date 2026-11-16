/**
 * One case per finding code, plus the negative cases that matter.
 *
 * The negative cases are the point: a diagnostics tool that reports problems on
 * a correct payment is worse than no tool at all.
 */

import { describe, expect, it } from "vitest";
import { diagnose } from "@x402-lens/core";
import {
  BASE_SEPOLIA,
  NOW,
  PAY_TO,
  PAYER,
  USDC_BASE_SEPOLIA,
  challenge,
  payloadWithAuth,
  paymentPayload,
} from "./fixtures";

const codes = (input: Parameters<typeof diagnose>[0]) =>
  diagnose({ now: NOW, ...input }).map(finding => finding.code);

describe("valid payment", () => {
  it("reports nothing", () => {
    const findings = diagnose({
      now: NOW,
      paymentRequired: challenge(),
      paymentPayload: paymentPayload(),
      verifyResponse: { isValid: true, payer: PAYER },
      settleResponse: {
        success: true,
        transaction: "0xabc",
        network: BASE_SEPOLIA,
        payer: PAYER,
      },
    });
    expect(findings).toEqual([]);
  });

  it("reports nothing for a challenge alone", () => {
    expect(diagnose({ now: NOW, paymentRequired: challenge() })).toEqual([]);
  });

  it("reports nothing for an empty input", () => {
    expect(diagnose({ now: NOW })).toEqual([]);
  });
});

describe("x402_version_mismatch", () => {
  it("flags a v1 payload", () => {
    expect(codes({ paymentPayload: paymentPayload({ x402Version: 1 }) })).toContain(
      "x402_version_mismatch",
    );
  });

  it("names PAYMENT-SIGNATURE in the fix", () => {
    const findings = diagnose({
      now: NOW,
      paymentPayload: paymentPayload({ x402Version: 1 }),
    });
    const hit = findings.find(finding => finding.code === "x402_version_mismatch");
    expect(hit?.fix).toMatch(/PAYMENT-SIGNATURE/);
    expect(hit?.severity).toBe("error");
  });
});

describe("missing_accepts", () => {
  it("flags an empty accepts array", () => {
    expect(codes({ paymentRequired: challenge({ accepts: [] }) })).toContain(
      "missing_accepts",
    );
  });

  it("flags a challenge with no accepts key", () => {
    const { accepts: _omitted, ...withoutAccepts } = challenge();
    expect(codes({ paymentRequired: withoutAccepts })).toContain("missing_accepts");
  });
});

describe("network_not_caip2", () => {
  it("flags a v1 shorthand on the payment and suggests the CAIP-2 id", () => {
    const findings = diagnose({
      now: NOW,
      paymentPayload: paymentPayload({
        accepted: {
          scheme: "exact",
          network: "base-sepolia",
          amount: "10000",
          asset: "0x0",
          payTo: PAY_TO,
        },
      }),
    });
    const hit = findings.find(finding => finding.code === "network_not_caip2");
    expect(hit?.fix).toContain("eip155:84532");
  });

  it("flags a shorthand in the challenge", () => {
    const findings = diagnose({
      paymentRequired: challenge({
        accepts: [
          {
            scheme: "exact",
            network: "base",
            amount: "10000",
            asset: "0x0",
            payTo: PAY_TO,
            maxTimeoutSeconds: 60,
          },
        ],
      }),
    });
    const hit = findings.find(finding => finding.code === "network_not_caip2");
    expect(hit?.fix).toContain("eip155:8453");
  });
});

describe("network_not_offered", () => {
  it("flags a network the challenge does not offer and lists the alternatives", () => {
    const findings = diagnose({
      paymentRequired: challenge(),
      paymentPayload: paymentPayload({
        accepted: {
          scheme: "exact",
          network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
          amount: "10000",
          asset: "0x0",
          payTo: PAY_TO,
        },
      }),
    });
    const hit = findings.find(finding => finding.code === "network_not_offered");
    expect(hit?.problem).toContain(BASE_SEPOLIA);
  });
});

describe("amount_not_atomic", () => {
  it("flags a decimal value in the authorization", () => {
    const findings = diagnose({
      now: NOW,
      paymentPayload: payloadWithAuth({ value: "0.01" }),
    });
    const hit = findings.find(finding => finding.code === "amount_not_atomic");
    expect(hit?.field).toBe("payment.authorization.value");
    expect(hit?.fix).toContain("atomic units");
  });

  it("flags a decimal amount in the challenge", () => {
    const findings = diagnose({
      paymentRequired: challenge({
        accepts: [
          {
            scheme: "exact",
            network: BASE_SEPOLIA,
            amount: "0.01",
            asset: "0x0",
            payTo: PAY_TO,
            maxTimeoutSeconds: 60,
          },
        ],
      }),
    });
    expect(findings.some(finding => finding.code === "amount_not_atomic")).toBe(true);
  });
});

describe("amount_mismatch", () => {
  it("flags underpayment", () => {
    const findings = diagnose({
      now: NOW,
      paymentRequired: challenge(),
      paymentPayload: payloadWithAuth({ value: "9999" }),
    });
    const hit = findings.find(finding => finding.code === "amount_mismatch");
    expect(hit?.fix).toContain("10000");
  });

  it("flags overpayment too, because the exact scheme rejects both", () => {
    const findings = diagnose({
      now: NOW,
      paymentRequired: challenge(),
      paymentPayload: payloadWithAuth({ value: "10001" }),
    });
    expect(findings.some(finding => finding.code === "amount_mismatch")).toBe(true);
  });

  it("maps the facilitator's value-mismatch reason", () => {
    const findings = diagnose({
      verifyResponse: {
        isValid: false,
        invalidReason: "invalid_exact_evm_payload_authorization_value_mismatch",
      },
    });
    expect(findings[0]?.code).toBe("amount_mismatch");
  });
});

describe("multiple accepts entries", () => {
  const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
  const SOLANA_ASSET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const SOLANA_PAY_TO = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

  const evmAccept = {
    scheme: "exact",
    network: BASE_SEPOLIA,
    amount: "10000",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra: { name: "USDC", version: "2" },
  };
  const solanaAccept = {
    scheme: "exact",
    network: SOLANA_DEVNET,
    amount: "20000",
    asset: SOLANA_ASSET,
    payTo: SOLANA_PAY_TO,
    maxTimeoutSeconds: 60,
  };

  it("compares against the chosen entry, not the first one offered", () => {
    // A route priced on both Base and Solana advertises different amounts and
    // recipients per entry. Paying the Base entry is correct even when Solana
    // is listed first.
    const findings = diagnose({
      now: NOW,
      paymentRequired: challenge({ accepts: [solanaAccept, evmAccept] }),
      paymentPayload: payloadWithAuth({ value: "10000", to: PAY_TO }, { accepted: evmAccept }),
      verifyResponse: { isValid: true, payer: PAYER },
    });
    expect(findings).toEqual([]);
  });

  it("still flags a payment that matches no offered entry by amount", () => {
    const findings = diagnose({
      now: NOW,
      paymentRequired: challenge({ accepts: [solanaAccept, evmAccept] }),
      paymentPayload: payloadWithAuth({ value: "9999", to: PAY_TO }, { accepted: evmAccept }),
    });
    const hit = findings.find(finding => finding.code === "amount_mismatch");
    expect(hit?.problem).toContain("10000");
    expect(hit?.problem).toContain(BASE_SEPOLIA);
  });

  it("does not invent amount findings when the offer itself is not offered", () => {
    // `network_not_offered` already names the real problem; reporting an amount
    // mismatch against an unrelated entry would point at the wrong field.
    const findings = diagnose({
      now: NOW,
      paymentRequired: challenge({ accepts: [evmAccept] }),
      paymentPayload: payloadWithAuth(
        { value: "20000", to: SOLANA_PAY_TO },
        { accepted: solanaAccept },
      ),
    });
    expect(findings.map(finding => finding.code)).toEqual(["network_not_offered"]);
  });

  it("flags a non-atomic amount in any offer, not only the first", () => {
    const findings = diagnose({
      now: NOW,
      paymentRequired: challenge({
        accepts: [evmAccept, { ...solanaAccept, amount: "0.02" }],
      }),
    });
    const hit = findings.find(finding => finding.code === "amount_not_atomic");
    expect(hit?.field).toBe("challenge.accepts[1].amount");
  });
});

describe("eip712_domain_mismatch", () => {
  it("stays quiet for a conformant challenge", () => {
    expect(diagnose({ now: NOW, paymentRequired: challenge() })).toEqual([]);
  });

  it("warns when the domain has no token name", () => {
    const findings = diagnose({
      now: NOW,
      paymentRequired: challenge({
        accepts: [
          {
            scheme: "exact",
            network: BASE_SEPOLIA,
            amount: "10000",
            asset: USDC_BASE_SEPOLIA,
            payTo: PAY_TO,
            maxTimeoutSeconds: 60,
            extra: { version: "2" },
          },
        ],
      }),
    });

    const hit = findings.find(finding => finding.code === "eip712_domain_mismatch");
    expect(hit?.severity).toBe("warn");
    expect(hit?.field).toBe("challenge.accepts.extra.name");
    expect(hit?.fix).toContain("extra.name");
  });

  it("warns when the version is absent, since the client would have to guess", () => {
    const findings = diagnose({
      now: NOW,
      paymentRequired: challenge({
        accepts: [
          {
            scheme: "exact",
            network: BASE_SEPOLIA,
            amount: "10000",
            asset: USDC_BASE_SEPOLIA,
            payTo: PAY_TO,
            maxTimeoutSeconds: 60,
            extra: { name: "USDC" },
          },
        ],
      }),
    });

    const hit = findings.find(finding => finding.code === "eip712_domain_mismatch");
    expect(hit?.field).toBe("challenge.accepts.extra.version");
    expect(hit?.fix).toContain("2");
  });

  it("flags a version that is not a string", () => {
    const findings = diagnose({
      now: NOW,
      paymentRequired: challenge({
        accepts: [
          {
            scheme: "exact",
            network: BASE_SEPOLIA,
            amount: "10000",
            asset: USDC_BASE_SEPOLIA,
            payTo: PAY_TO,
            maxTimeoutSeconds: 60,
            extra: { name: "USDC", version: 2 },
          },
        ],
      }),
    });

    const hit = findings.find(finding => finding.code === "eip712_domain_mismatch");
    expect(hit?.severity).toBe("error");
  });

  it("says nothing about a Solana offer, which has no EIP-712 domain", () => {
    const findings = diagnose({
      now: NOW,
      paymentRequired: challenge({
        accepts: [
          {
            scheme: "exact",
            network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
            amount: "10000",
            asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            payTo: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
            maxTimeoutSeconds: 60,
          },
        ],
      }),
    });

    expect(findings.some(finding => finding.code === "eip712_domain_mismatch")).toBe(false);
  });
});

describe("solana offers", () => {
  const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
  const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const SOL_PAY_TO = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

  const solanaAccept = (overrides: Record<string, unknown> = {}) => ({
    scheme: "exact",
    network: SOLANA_DEVNET,
    amount: "10000",
    asset: MINT,
    payTo: SOL_PAY_TO,
    maxTimeoutSeconds: 60,
    ...overrides,
  });

  it("accepts a conformant Solana offer", () => {
    const findings = diagnose({
      now: NOW,
      paymentRequired: challenge({ accepts: [solanaAccept()] }),
    });
    expect(findings).toEqual([]);
  });

  it("flags an EVM address advertised as a Solana recipient", () => {
    // The exact bug that shipped in 0.1.0: one payTo reused for every network.
    const findings = diagnose({
      now: NOW,
      paymentRequired: challenge({ accepts: [solanaAccept({ payTo: PAY_TO })] }),
    });

    const hit = findings.find(finding => finding.code === "pay_to_mismatch");
    expect(hit?.severity).toBe("error");
    expect(hit?.field).toBe("challenge.accepts[0].payTo");
    expect(hit?.problem).toContain("unpayable");
    expect(hit?.fix).toContain("base58");
  });

  it("flags an EVM contract address advertised as a Solana mint", () => {
    const findings = diagnose({
      now: NOW,
      paymentRequired: challenge({ accepts: [solanaAccept({ asset: USDC_BASE_SEPOLIA })] }),
    });

    const hit = findings.find(finding => finding.code === "asset_mismatch");
    expect(hit?.field).toBe("challenge.accepts[0].asset");
    expect(hit?.fix).toContain("mint");
  });

  it("names the right entry when only one of several offers is broken", () => {
    const findings = diagnose({
      now: NOW,
      paymentRequired: challenge({
        accepts: [
          {
            scheme: "exact",
            network: BASE_SEPOLIA,
            amount: "10000",
            asset: USDC_BASE_SEPOLIA,
            payTo: PAY_TO,
            maxTimeoutSeconds: 60,
            extra: { name: "USDC", version: "2" },
          },
          solanaAccept({ payTo: "not-a-solana-key" }),
        ],
      }),
    });

    const hit = findings.find(finding => finding.code === "pay_to_mismatch");
    expect(hit?.field).toBe("challenge.accepts[1].payTo");
  });

  it("does not report an amount mismatch from a Solana payload it cannot read", () => {
    // A Solana payment carries a signed transaction, not an authorization, so the
    // amount is not inspectable. Claiming a mismatch would be a guess.
    const findings = diagnose({
      now: NOW,
      paymentRequired: challenge({ accepts: [solanaAccept()] }),
      paymentPayload: {
        x402Version: 2,
        accepted: solanaAccept(),
        payload: { transaction: "AQABAg==" },
      },
      verifyResponse: { isValid: true, payer: SOL_PAY_TO },
    });

    expect(findings.filter(finding => finding.code === "amount_mismatch")).toEqual([]);
  });
});

describe("pay_to_mismatch", () => {
  it("flags a different recipient", () => {
    const other = "0x0000000000000000000000000000000000000001";
    const findings = diagnose({
      now: NOW,
      paymentRequired: challenge(),
      paymentPayload: payloadWithAuth({ to: other }),
    });
    const hit = findings.find(finding => finding.code === "pay_to_mismatch");
    expect(hit?.problem).toContain(other);
    expect(hit?.problem).toContain(PAY_TO);
  });

  it("ignores address casing", () => {
    const findings = diagnose({
      now: NOW,
      paymentRequired: challenge(),
      paymentPayload: payloadWithAuth({ to: PAY_TO.toLowerCase() }),
    });
    expect(findings.some(finding => finding.code === "pay_to_mismatch")).toBe(false);
  });
});

describe("asset_mismatch", () => {
  it("flags a different token contract", () => {
    const findings = diagnose({
      now: NOW,
      paymentRequired: challenge(),
      paymentPayload: paymentPayload({
        accepted: {
          scheme: "exact",
          network: BASE_SEPOLIA,
          amount: "10000",
          asset: "0x0000000000000000000000000000000000000002",
          payTo: PAY_TO,
        },
      }),
    });
    const hit = findings.find(finding => finding.code === "asset_mismatch");
    expect(hit?.fix).toContain("verifyingContract");
  });
});

describe("authorization window", () => {
  it("flags an expired authorization", () => {
    const findings = diagnose({
      now: NOW,
      paymentPayload: payloadWithAuth({ validBefore: "1740672088" }),
    });
    expect(findings.some(finding => finding.code === "authorization_expired")).toBe(true);
  });

  it("flags one that is not valid yet", () => {
    const findings = diagnose({
      now: NOW,
      paymentPayload: payloadWithAuth({ validAfter: "1740674090" }),
    });
    expect(findings.some(finding => finding.code === "authorization_not_yet_valid")).toBe(true);
  });

  it("accepts a window that contains the current time", () => {
    const findings = diagnose({
      now: NOW,
      paymentPayload: payloadWithAuth({
        validAfter: String(Math.floor(NOW / 1000) - 10),
        validBefore: String(Math.floor(NOW / 1000) + 10),
      }),
    });
    expect(findings).toEqual([]);
  });
});

describe("signature_mismatch", () => {
  it("explains how to rebuild the EIP-712 domain", () => {
    const findings = diagnose({
      verifyResponse: {
        isValid: false,
        invalidReason: "invalid_exact_evm_payload_signature",
      },
      paymentRequired: challenge(),
    });
    const hit = findings.find(finding => finding.code === "signature_mismatch");
    expect(hit?.severity).toBe("error");
    expect(hit?.fix).toContain("extra.name");
    expect(hit?.fix).toContain("USDC");
    expect(hit?.fix).toContain("verifyingContract");
  });

  it("keeps an unmapped facilitator reason instead of dropping it", () => {
    const findings = diagnose({
      verifyResponse: { isValid: false, invalidReason: "some_new_reason" },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.problem).toContain("some_new_reason");
    expect(findings[0]?.severity).toBe("warn");
  });

  it("builds the hint from the challenge, not from a stale client echo", () => {
    // The client signed against a v1 shorthand and the wrong token: the hint
    // must still describe the server's actual domain.
    const findings = diagnose({
      verifyResponse: {
        isValid: false,
        invalidReason: "invalid_exact_evm_payload_signature",
      },
      paymentRequired: challenge(),
      paymentPayload: paymentPayload({
        accepted: {
          scheme: "exact",
          network: "base-sepolia",
          amount: "10000",
          asset: "0x0000000000000000000000000000000000000009",
          payTo: PAY_TO,
        },
      }),
    });
    const hit = findings.find(finding => finding.code === "signature_mismatch");
    expect(hit?.fix).toContain('"USDC"');
    expect(hit?.fix).toContain("Base Sepolia");
    expect(hit?.fix).toContain("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    expect(hit?.fix).not.toContain("0x0000000000000000000000000000000000000009");
  });
});

describe("settlement verdicts", () => {
  it("treats settlement_pending as non-terminal and warns against retrying", () => {
    const findings = diagnose({
      settleResponse: {
        success: false,
        errorReason: "settlement_pending",
        transaction: "0xdeadbeef",
        network: BASE_SEPOLIA,
      },
    });
    const hit = findings.find(finding => finding.code === "settlement_pending");
    expect(hit?.severity).toBe("warn");
    expect(hit?.fix).toMatch(/reconcile|Reconcile/i);
    expect(hit?.fix).toMatch(/do not place a second payment|twice/i);
  });

  it("treats any other settle failure as terminal", () => {
    const findings = diagnose({
      settleResponse: {
        success: false,
        errorReason: "insufficient_funds",
        network: BASE_SEPOLIA,
      },
    });
    expect(findings[0]?.severity).toBe("error");
  });

  it("says nothing about a successful settlement", () => {
    expect(
      diagnose({ settleResponse: { success: true, transaction: "0x1", network: BASE_SEPOLIA } }),
    ).toEqual([]);
  });
});

describe("ordering", () => {
  it("puts errors before warnings and info", () => {
    const findings = diagnose({
      now: NOW,
      paymentRequired: challenge({ accepts: [] }),
      paymentPayload: payloadWithAuth({ value: "0.01" }),
      settleResponse: {
        success: false,
        errorReason: "settlement_pending",
        transaction: "0xabc",
        network: BASE_SEPOLIA,
      },
    });
    const severities = findings.map(finding => finding.severity);
    const firstWarn = severities.indexOf("warn");
    expect(firstWarn).toBeGreaterThan(-1);
    expect(severities.slice(firstWarn)).not.toContain("error");
  });
});
