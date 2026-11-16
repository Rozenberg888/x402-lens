/**
 * CLI output is the UX. Snapshot the rendered text so an accidental format
 * change fails the build instead of surprising operators mid-incident.
 */

import { describe, expect, it } from "vitest";
import { explainPayment } from "../packages/cli/src/commands/explain";
import { challenge, payloadWithAuth, BASE_SEPOLIA, PAY_TO, USDC_BASE_SEPOLIA } from "./fixtures";

describe("CLI snapshots", () => {
  it("explain renders a stable diagnosis for a signature mismatch", async () => {
    const result = await explainPayment({
      challenge: JSON.stringify(challenge()),
      // Far-future window so the snapshot stays about the signature, not expiry.
      payment: JSON.stringify(payloadWithAuth({ validBefore: "9999999999", validAfter: "0" })),
      verify: JSON.stringify({
        isValid: false,
        invalidReason: "invalid_exact_evm_payload_signature",
        payer: "0x857b06519E91e3A54538791bDAbd0E22373e36b66",
      }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.text).toMatchInlineSnapshot(`
      "x402-lens explain
        challenge: yes
        payment:   yes
        verify:    invalid
        settle:    no

      ERROR signature_mismatch
        field:   payment.payload.signature
        problem: The signature does not recover to the payer address.
        fix:     Rebuild the EIP-712 domain from extra.name ("USDC"), extra.version ("2"), the chain id of Base Sepolia (${BASE_SEPOLIA}), and verifyingContract = ${USDC_BASE_SEPOLIA}. Then sign with the same account as authorization.from."
    `);
  });

  it("explain reports settlement_pending with reconcile advice", async () => {
    const result = await explainPayment({
      settle: JSON.stringify({
        success: false,
        errorReason: "settlement_pending",
        transaction: "0xdeadbeef",
        network: BASE_SEPOLIA,
        payer: PAY_TO,
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.text).toContain("settlement_pending");
    expect(result.text).toContain("x402-lens reconcile");
    expect(result.text).toMatchInlineSnapshot(`
      "x402-lens explain
        challenge: no
        payment:   no
        verify:    no
        settle:    failed

      WARN  settlement_pending
        field:   settlement.transaction
        problem: The transaction was broadcast (0xdeadbeef) but its confirmation could not be established. This is non-terminal: it may still confirm.
        fix:     Run \`x402-lens reconcile --tx <hash>\` before retrying. Do not treat the 402 as a rejection and do not place a second payment — that risks charging the buyer twice."
    `);
  });
});
