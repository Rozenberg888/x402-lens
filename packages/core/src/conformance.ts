/**
 * Reading and validating x402 v2 wire objects, independent of any SDK.
 *
 * The CLI needs this to inspect a live endpoint, and the conformance tests need
 * it to assert against the spec. Keeping it here means the same checks apply to
 * captured JSON and to a live response.
 */

import type {
  WirePaymentPayload,
  WirePaymentRequired,
  WirePaymentRequirements,
} from "./wire.js";
import { isAtomicAmount, isCaip2Network } from "./wire.js";

/** One schema violation in a `PaymentRequired` object. */
export interface ConformanceIssue {
  field: string;
  problem: string;
}

/**
 * Validate a `PaymentRequired` against the x402 v2 schema.
 *
 * Only checks what the spec marks required, plus the invariants that break
 * clients in practice (atomic amounts, CAIP-2 networks).
 *
 * @param value - Parsed `PaymentRequired`
 * @returns Every violation found; empty means conformant
 */
export function validatePaymentRequired(value: unknown): ConformanceIssue[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [{ field: "$", problem: "PaymentRequired must be a JSON object." }];
  }

  const pr = value as Partial<WirePaymentRequired>;
  const issues: ConformanceIssue[] = [];

  if (pr.x402Version !== 2) {
    issues.push({
      field: "x402Version",
      problem: `Required, must be 2 (found ${JSON.stringify(pr.x402Version)}).`,
    });
  }

  if (!pr.resource || typeof pr.resource !== "object") {
    issues.push({ field: "resource", problem: "Required ResourceInfo object is missing." });
  } else if (typeof pr.resource.url !== "string" || pr.resource.url.length === 0) {
    issues.push({ field: "resource.url", problem: "Required URL is missing." });
  }

  if (!Array.isArray(pr.accepts)) {
    issues.push({ field: "accepts", problem: "Required array is missing." });
  } else if (pr.accepts.length === 0) {
    issues.push({ field: "accepts", problem: "Must contain at least one payment option." });
  } else {
    pr.accepts.forEach((entry, index) => {
      issues.push(...validateAccept(entry, index));
    });
  }

  return issues;
}

function validateAccept(
  entry: WirePaymentRequirements | undefined,
  index: number,
): ConformanceIssue[] {
  const at = `accepts[${index}]`;
  if (!entry || typeof entry !== "object") {
    return [{ field: at, problem: "Must be an object." }];
  }

  const issues: ConformanceIssue[] = [];

  if (typeof entry.scheme !== "string" || entry.scheme.length === 0) {
    issues.push({ field: `${at}.scheme`, problem: "Required string is missing." });
  }
  if (!isCaip2Network(entry.network)) {
    issues.push({
      field: `${at}.network`,
      problem: `Must be a CAIP-2 id (e.g. eip155:84532), found ${JSON.stringify(entry.network)}.`,
    });
  }
  if (!isAtomicAmount(entry.amount)) {
    issues.push({
      field: `${at}.amount`,
      problem: `Must be an atomic-unit integer string, found ${JSON.stringify(entry.amount)}.`,
    });
  }
  if (typeof entry.asset !== "string" || entry.asset.length === 0) {
    issues.push({ field: `${at}.asset`, problem: "Required string is missing." });
  }
  if (typeof entry.payTo !== "string" || entry.payTo.length === 0) {
    issues.push({ field: `${at}.payTo`, problem: "Required string is missing." });
  }
  if (typeof entry.maxTimeoutSeconds !== "number" || entry.maxTimeoutSeconds <= 0) {
    issues.push({
      field: `${at}.maxTimeoutSeconds`,
      problem: "Required positive number is missing.",
    });
  }

  return issues;
}

/**
 * Validate that a payload chose an option the challenge actually offered.
 *
 * @param payload - Decoded `PAYMENT-SIGNATURE`
 * @param required - Decoded `PAYMENT-REQUIRED`
 * @returns Violations found; empty means acceptable
 */
export function validatePayloadAgainstChallenge(
  payload: WirePaymentPayload | unknown,
  required: WirePaymentRequired | unknown,
): ConformanceIssue[] {
  const issues: ConformanceIssue[] = [];

  // Untrusted input reaches this from the CLI and from captured JSON. Refuse
  // anything that is not an object before touching fields — a throw here would
  // turn a bad paste into a crashed debugger.
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return [{ field: "payment", problem: "PaymentPayload must be a JSON object." }];
  }
  if (typeof required !== "object" || required === null || Array.isArray(required)) {
    return [{ field: "challenge", problem: "PaymentRequired must be a JSON object." }];
  }

  const payment = payload as WirePaymentPayload;
  const challenge = required as WirePaymentRequired;

  if (payment.x402Version !== 2) {
    issues.push({ field: "payment.x402Version", problem: "Must be 2." });
  }

  const accepted = payment.accepted;
  if (!accepted) {
    issues.push({ field: "payment.accepted", problem: "Required." });
    return issues;
  }

  const offered = challenge.accepts ?? [];
  const matching = offered.some(
    entry => entry.network === accepted.network && entry.scheme === accepted.scheme,
  );
  if (!matching) {
    issues.push({
      field: "payment.accepted",
      problem: "Does not match any accepts[] entry offered by the challenge.",
    });
  }

  return issues;
}

/** CORS expectations for a browser-based buyer. */
export interface CorsReport {
  exposesPaymentRequired: boolean;
  exposesPaymentResponse: boolean;
  allowsPaymentSignature: boolean;
  issues: ConformanceIssue[];
}

/**
 * Check the CORS headers a browser buyer needs.
 *
 * None of the three payment headers is CORS-safelisted, so a cross-origin
 * `fetch()` cannot read or send them without explicit exposure. This failure is
 * silent in the browser, which is why it is worth checking from the outside.
 *
 * @param headers - Response headers (lowercase keys recommended)
 * @returns What is exposed, plus findings for what is not
 */
export function checkCors(headers: Record<string, string | undefined>): CorsReport {
  const exposed = (headers["access-control-expose-headers"] ?? "")
    .toLowerCase()
    .split(",")
    .map(part => part.trim())
    .filter(Boolean);
  const allowed = (headers["access-control-allow-headers"] ?? "")
    .toLowerCase()
    .split(",")
    .map(part => part.trim())
    .filter(Boolean);

  const exposesPaymentRequired = exposed.includes("payment-required");
  const exposesPaymentResponse = exposed.includes("payment-response");
  const allowsPaymentSignature = allowed.includes("payment-signature");

  const issues: ConformanceIssue[] = [];
  const missingExposed = [
    ...(exposesPaymentRequired ? [] : ["PAYMENT-REQUIRED"]),
    ...(exposesPaymentResponse ? [] : ["PAYMENT-RESPONSE"]),
  ];
  if (missingExposed.length > 0) {
    issues.push({
      field: "Access-Control-Expose-Headers",
      problem: `Missing ${missingExposed.join(", ")}. A cross-origin buyer cannot read them, so it never learns the price.`,
    });
  }
  if (!allowsPaymentSignature) {
    issues.push({
      field: "Access-Control-Allow-Headers",
      problem:
        "Missing PAYMENT-SIGNATURE. The browser strips the retry header and the payment is silently not made. Add Content-Type alongside it when requests carry a body.",
    });
  }

  const allowOrigin = headers["access-control-allow-origin"]?.trim();
  if (
    (exposesPaymentRequired || exposesPaymentResponse || allowsPaymentSignature) &&
    !allowOrigin
  ) {
    issues.push({
      field: "Access-Control-Allow-Origin",
      problem:
        "Payment CORS headers are present but Access-Control-Allow-Origin is missing. Cross-origin browser buyers still cannot read the challenge; set cors: { origin } in paymentLens or in your CORS middleware.",
    });
  }

  return {
    exposesPaymentRequired,
    exposesPaymentResponse,
    allowsPaymentSignature,
    issues,
  };
}
