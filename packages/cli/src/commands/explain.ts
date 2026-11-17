/**
 * `x402-lens explain` — why did this payment fail.
 *
 * Feed it any subset of the exchange: the challenge, the payment the client
 * sent, and the facilitator's verify or settle response. It runs the findings
 * engine and prints the result with fixes.
 */

import {
  diagnose,
  formatFindings,
  type Finding,
  type WirePaymentPayload,
  type WirePaymentRequired,
  type WireSettleResponse,
  type WireVerifyResponse,
} from "@x402-lens/core";
import { readJsonArgument } from "../input.js";

export interface ExplainInput {
  challenge?: string;
  payment?: string;
  verify?: string;
  settle?: string;
}

export interface ExplainResult {
  text: string;
  exitCode: number;
  findingCount: number;
  /** Structured findings for `--json` consumers. */
  findings: Finding[];
}

/**
 * Diagnose a captured exchange.
 *
 * @param input - Raw arguments, each JSON / base64 / `@file`
 * @returns Rendered report and an exit code (1 when anything is an error)
 */
export async function explainPayment(input: ExplainInput): Promise<ExplainResult> {
  const paymentRequired = input.challenge
    ? ((await readJsonArgument(input.challenge, "--challenge")) as WirePaymentRequired)
    : undefined;
  const paymentPayload = input.payment
    ? ((await readJsonArgument(input.payment, "--payment")) as WirePaymentPayload)
    : undefined;
  const verifyResponse = input.verify
    ? ((await readJsonArgument(input.verify, "--verify")) as WireVerifyResponse)
    : undefined;
  const settleResponse = input.settle
    ? ((await readJsonArgument(input.settle, "--settle")) as WireSettleResponse)
    : undefined;

  if (!paymentRequired && !paymentPayload && !verifyResponse && !settleResponse) {
    return {
      text: [
        "Nothing to explain.",
        "",
        "Pass at least one of:",
        "  --challenge <PAYMENT-REQUIRED|@file>   the 402 terms",
        "  --payment   <PAYMENT-SIGNATURE|@file>  what the client sent",
        "  --verify    <json|@file>               facilitator /verify response",
        "  --settle    <json|@file>               facilitator /settle response",
      ].join("\n"),
      exitCode: 2,
      findingCount: 0,
      findings: [],
    };
  }

  const findings = diagnose({
    ...(paymentRequired ? { paymentRequired } : {}),
    ...(paymentPayload ? { paymentPayload } : {}),
    ...(verifyResponse ? { verifyResponse } : {}),
    ...(settleResponse ? { settleResponse } : {}),
  });

  const header = [
    "x402-lens explain",
    `  challenge: ${paymentRequired ? "yes" : "no"}`,
    `  payment:   ${paymentPayload ? "yes" : "no"}`,
    `  verify:    ${verifyResponse ? (verifyResponse.isValid ? "valid" : "invalid") : "no"}`,
    `  settle:    ${settleResponse ? (settleResponse.success ? "settled" : "failed") : "no"}`,
  ].join("\n");

  const hasError = findings.some(finding => finding.severity === "error");

  return {
    text: `${header}\n\n${formatFindings(findings)}`,
    exitCode: hasError ? 1 : 0,
    findingCount: findings.length,
    findings,
  };
}
