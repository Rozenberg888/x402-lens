/**
 * `x402-lens inspect` — look at a live endpoint from the outside.
 *
 * Sends an unpaid request, decodes the challenge, and reports both schema
 * conformance and CORS readiness. That is the whole "is my paywall correct"
 * question, answerable without reading the server's source.
 */

import {
  checkCors,
  describeNetwork,
  diagnose,
  formatFindings,
  validatePaymentRequired,
  type WirePaymentRequired,
} from "@x402-lens/core";
import { decodePaymentRequiredHeader } from "@x402/core/http";

export interface InspectOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface InspectResult {
  status: number;
  paymentRequired?: WirePaymentRequired;
  headerPresent: boolean;
  /**
   * The header was present but could not be decoded, and the body did not supply
   * a challenge either.
   *
   * Distinct from "no challenge at all": a corrupt header is a regression in a
   * paywall that used to work, while a missing one means the route was never
   * paid. `watch` reports them differently for that reason.
   */
  headerUndecodable: boolean;
  decodedFromBody: boolean;
  conformance: ReturnType<typeof validatePaymentRequired>;
  cors: ReturnType<typeof checkCors>;
  findings: string;
  /** Non-zero when the endpoint is not a working x402 v2 paywall. */
  exitCode: number;
}

/**
 * Inspect one endpoint.
 *
 * @param options - Target URL and request tweaks
 * @returns Everything observed, plus an exit code for CI use
 */
export async function inspectEndpoint(options: InspectOptions): Promise<InspectResult> {
  const method = options.method ?? "GET";
  const response = await fetch(options.url, {
    method,
    headers: {
      Accept: "application/json",
      "User-Agent": "x402-lens/0.2",
      ...options.headers,
    },
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    // Do not follow redirects away from a 402 paywall.
    redirect: "manual",
  });

  const headerValue = response.headers.get("payment-required");
  let paymentRequired: WirePaymentRequired | undefined;
  let decodedFromBody = false;
  let headerPresent = false;
  let headerUndecodable = false;

  if (headerValue) {
    headerPresent = true;
    try {
      paymentRequired = decodePaymentRequiredHeader(headerValue) as unknown as WirePaymentRequired;
    } catch {
      // Fall through to the body, which we mirror there on purpose.
      headerUndecodable = true;
    }
  }

  if (!paymentRequired) {
    // Our middleware mirrors the challenge into the body; other servers may too.
    const text = await response.text().catch(() => "");
    const fromBody = extractChallengeFromBody(text);
    if (fromBody) {
      paymentRequired = fromBody;
      decodedFromBody = true;
    }
  }

  // Normalise `accepts` to an array of objects before anything reads it.
  //
  // Every consumer below — `validatePaymentRequired`, `diagnose`,
  // `describeChallenge` — assumes an array of object entries. A server under
  // diagnosis can send `accepts: null`, `accepts: [null]`, or `accepts: "nope"`,
  // and the tool exists for exactly that case. Without this normalisation each
  // consumer crashes separately and the CLI reports a TypeError as a network
  // failure; a raw (unfiltered) array is still passed through so conformance can
  // report the original defect.
  if (paymentRequired) {
    const rawAccepts = (paymentRequired as { accepts?: unknown }).accepts;
    (paymentRequired as { accepts?: unknown }).accepts = Array.isArray(rawAccepts)
      ? rawAccepts
      : rawAccepts === undefined
        ? []
        : [rawAccepts];
  }

  const headerRecord: Record<string, string | undefined> = {};
  response.headers.forEach((value, key) => {
    headerRecord[key.toLowerCase()] = value;
  });
  const cors = checkCors(headerRecord);

  const conformance = paymentRequired ? validatePaymentRequired(paymentRequired) : [];

  // `diagnose` assumes a challenge-shaped object and dereferences
  // `accepts[].network`. A hostile or buggy server can return `accepts: [null]`,
  // and the tool exists to diagnose broken servers — malformed input is the
  // expected case, not an edge case. Reproduced before this guard: the TypeError
  // escaped, was caught by the network handler, and was reported as
  // "Could not reach <url>: Cannot read properties of null (reading 'network')",
  // blaming the connection for the response body.
  //
  // When conformance already reports the challenge as malformed there is nothing
  // extra a deeper diagnosis can add, so the shallow check is the whole answer.
  const findingsList = paymentRequired && conformance.length === 0
    ? diagnose({ paymentRequired })
    : [];

  const lines: string[] = [];
  lines.push(`${method} ${options.url} → HTTP ${response.status}`);
  if (!paymentRequired) {
    lines.push("");
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location") ?? "(no Location header)";
      lines.push(
        `Redirected (HTTP ${response.status}) to ${location}. inspect does not follow redirects, so a reverse proxy can hide a 402 paywall behind a 3xx.`,
      );
      lines.push(
        "Point inspect at the final paywall URL, or stop the redirect for this path.",
      );
    } else {
      lines.push(
        "No x402 challenge found. Expected a PAYMENT-REQUIRED header (base64 PaymentRequired) on a 402 response.",
      );
      lines.push(
        "If this route is unprotected, you will see its normal response instead. If it is protected, check that paymentMiddleware is mounted before the route.",
      );
    }
  } else {
    lines.push(
      headerPresent
        ? "Challenge: PAYMENT-REQUIRED header"
        : "Challenge: response body (no PAYMENT-REQUIRED header)",
    );
    lines.push(describeChallenge(paymentRequired));
  }

  if (conformance.length > 0) {
    lines.push("");
    lines.push("Schema conformance:");
    for (const issue of conformance) {
      lines.push(`  [error] ${issue.field}: ${issue.problem}`);
    }
  }

  if (cors.issues.length > 0) {
    lines.push("");
    lines.push("Browser (CORS):");
    for (const issue of cors.issues) {
      lines.push(`  [error] ${issue.field}: ${issue.problem}`);
    }
  } else if (paymentRequired) {
    lines.push("");
    lines.push("Browser (CORS): PAYMENT-REQUIRED, PAYMENT-RESPONSE exposed; PAYMENT-SIGNATURE allowed.");
  }

  if (findingsList.length > 0) {
    lines.push("");
    lines.push(formatFindings(findingsList));
  }

  // A finding with severity `error` means the paywall cannot work as advertised
  // — the same class as a schema violation. Leaving findings out of this
  // calculation printed
  //   ERROR eip712_domain_mismatch … The EIP-712 domain version is not a plain string.
  // and then exited 0, so a CI job gating on `inspect` passed a paywall the tool
  // had just declared broken. `warn` and `info` are advisory and stay non-fatal.
  const hasErrorFinding = findingsList.some(item => item.severity === "error");
  const failed =
    !paymentRequired ||
    conformance.length > 0 ||
    cors.issues.length > 0 ||
    hasErrorFinding;

  return {
    status: response.status,
    ...(paymentRequired ? { paymentRequired } : {}),
    headerPresent,
    // Only when the header existed, failed to decode, and the body did not
    // rescue it — otherwise a body-mirrored challenge would be mislabelled.
    headerUndecodable: headerUndecodable && paymentRequired === undefined,
    decodedFromBody,
    conformance,
    cors,
    findings: lines.join("\n"),
    exitCode: failed ? 1 : 0,
  };
}

function describeChallenge(paymentRequired: WirePaymentRequired): string {
  const lines = [`x402Version: ${String(paymentRequired.x402Version)}`];
  if (paymentRequired.resource?.url) {
    lines.push(`resource:    ${paymentRequired.resource.url}`);
  }
  if (paymentRequired.error) {
    lines.push(`error:       ${paymentRequired.error}`);
  }
  const accepts = paymentRequired.accepts ?? [];
  lines.push(`accepts:     ${accepts.length}`);
  accepts.forEach((entry, index) => {
    // `conformance` already reports a malformed entry; this function's job is to
    // print what arrived, and a hostile or buggy server can send `accepts: [null]`.
    // Dereferencing it here threw out of `inspectEndpoint`, so the tool crashed
    // on exactly the input it exists to diagnose, and the CLI reported it as a
    // network failure.
    if (!entry || typeof entry !== "object") {
      lines.push(`  [${index}] (not an object: ${JSON.stringify(entry)})`);
      return;
    }
    lines.push(
      `  [${index}] ${entry.scheme} on ${describeNetwork(entry.network)}`,
      `      amount: ${entry.amount} (atomic units)`,
      `      asset:  ${entry.asset}`,
      `      payTo:  ${entry.payTo}`,
      `      timeout: ${String(entry.maxTimeoutSeconds)}s`,
    );
  });
  if (accepts.length > 1) {
    // Two entries can be the same price and still differ in what the buyer
    // owes, because each chain has its own token decimals. Saying so prevents
    // the natural but wrong assumption that the amounts should match.
    //
    // Only well-formed entries take part: a `null` in the array is reported per
    // entry above, and reading `.amount` off it here would crash for the same
    // reason the loop did before.
    const wellFormed = accepts.filter(
      (entry): entry is NonNullable<typeof entry> => Boolean(entry) && typeof entry === "object",
    );
    const amounts = new Set(wellFormed.map(entry => entry.amount));
    const assets = new Set(wellFormed.map(entry => entry.asset));
    lines.push(
      `      note:   ${accepts.length} payment options — one per network. ${
        amounts.size === 1
          ? "Amounts match across networks."
          : `Amounts differ by token decimals (${Array.from(amounts).join(", ")}).`
      }`,
    );
    if (assets.size === 1 && wellFormed.length > 0) {
      lines.push(
        `      note:   Every option uses the same asset, which is only valid if that token exists on all of them.`,
      );
    }
  }
  return lines.join("\n");
}

/** Pull a mirrored challenge out of a JSON body or paywall-free error body. */
function extractChallengeFromBody(text: string): WirePaymentRequired | undefined {
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as { x402Version?: unknown }).x402Version === 2 &&
      Array.isArray((parsed as { accepts?: unknown }).accepts)
    ) {
      return parsed as WirePaymentRequired;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
