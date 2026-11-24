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
import { InputError, readJsonArgument } from "../input.js";

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
 * Require a decoded argument to be a JSON object.
 *
 * `readJsonArgument` accepts any JSON value, and `explain` then casts it to a
 * wire type. So `--challenge '[]'` — an array, not a challenge — passed the cast,
 * counted as "challenge: yes" in the header, and produced "The 402 response has
 * no accepts[] entries … Configure at least one route": advice about a server
 * that was never described. Any JSON that is not an object is a wrong argument,
 * so it is rejected as such.
 *
 * @param value - The decoded argument
 * @param label - Argument name, used in the error
 * @returns The same value, typed as an object bag
 * @throws {InputError} When the value is not a JSON object
 */
function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const kind = value === null ? "null" : Array.isArray(value) ? "an array" : typeof value;
    throw new InputError(
      `${label} must be a JSON object describing the ${label.slice(2)}, but it is ${kind}. Pass the header value verbatim, or the JSON object, or @file.`,
    );
  }
  return value as Record<string, unknown>;
}

/**
 * Diagnose a captured exchange.
 *
 * @param input - Raw arguments, each JSON / base64 / `@file`
 * @returns Rendered report and an exit code (1 when anything is an error)
 */
export async function explainPayment(input: ExplainInput): Promise<ExplainResult> {
  const paymentRequired = input.challenge
    ? (asObject(
        await readJsonArgument(input.challenge, "--challenge"),
        "--challenge",
      ) as unknown as WirePaymentRequired)
    : undefined;
  const paymentPayload = input.payment
    ? (asObject(
        await readJsonArgument(input.payment, "--payment"),
        "--payment",
      ) as unknown as WirePaymentPayload)
    : undefined;
  const verifyResponse = input.verify
    ? (asObject(
        await readJsonArgument(input.verify, "--verify"),
        "--verify",
      ) as unknown as WireVerifyResponse)
    : undefined;
  const settleResponse = input.settle
    ? (asObject(
        await readJsonArgument(input.settle, "--settle"),
        "--settle",
      ) as unknown as WireSettleResponse)
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
