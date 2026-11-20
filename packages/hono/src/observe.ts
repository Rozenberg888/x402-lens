/**
 * Observing the 402 on a framework that returns responses instead of mutating
 * them.
 *
 * Express hands you a mutable `res`, so the Express adapter patches
 * `setHeader`/`writeHead`/`json` to notice a challenge going out. Hono hands
 * back a `Response`, which is simpler and safer: read the finished response,
 * decode `PAYMENT-REQUIRED` if it is there, and (optionally) rebuild the body
 * with the challenge mirrored into it.
 *
 * Nothing here alters the wire form of the header. The one deliberate addition
 * is to the JSON body: v2 treats the response body as server-defined, and
 * mirroring the challenge there is what makes `curl | jq` usable without base64
 * in the loop.
 */

import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { WirePaymentRequired } from "@x402-lens/core";

/** Fields a client needs to see without base64-decoding the header. */
export function bodyFieldsFromChallenge(
  paymentRequired: WirePaymentRequired,
): Record<string, unknown> {
  return {
    x402Version: paymentRequired.x402Version,
    ...(paymentRequired.error ? { error: paymentRequired.error } : {}),
    ...(paymentRequired.resource ? { resource: paymentRequired.resource } : {}),
    ...(paymentRequired.accepts ? { accepts: paymentRequired.accepts } : {}),
  };
}

export interface ObserveOptions {
  /**
   * Mirror the decoded challenge into the 402 JSON body. The v2 spec leaves the
   * body to the server; a readable body is what makes `curl | jq` usable
   * without base64 in the loop. Set false to leave the body untouched.
   */
  mirrorBody?: boolean;
}

/**
 * Decode the challenge out of a finished response and report it.
 *
 * Returns the response unchanged unless `mirrorBody` is on and the body is
 * JSON — in that case a new `Response` carries the merged body, because a
 * `Response` body cannot be rewritten in place.
 *
 * Async only because reading a `Response` body is: a body that has already been
 * consumed simply yields no mirror, never an error on the payment path.
 *
 * @param response - The response the official middleware produced
 * @param onChallenge - Called once when the response carries a challenge
 * @param options - Whether to mirror the challenge into the body
 * @returns The response to send, possibly with a mirrored body
 */
export async function observePaymentRequired(
  response: Response,
  onChallenge: (paymentRequired: WirePaymentRequired) => void,
  options: ObserveOptions = {},
): Promise<Response> {
  if (response.status !== 402) return response;

  const raw = response.headers.get("payment-required");
  if (!raw) return response;

  let challenge: WirePaymentRequired;
  try {
    challenge = decodePaymentRequiredHeader(raw) as unknown as WirePaymentRequired;
  } catch {
    // A malformed header is the SDK's problem to surface, not ours.
    return response;
  }

  onChallenge(challenge);

  if (!(options.mirrorBody ?? true)) return response;

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) return response;

  const base = await readJsonObject(response);
  const headers = new Headers(response.headers);
  // The body changed size, so a copied `content-length` would truncate it.
  headers.delete("content-length");

  return new Response(
    JSON.stringify({ ...base, ...bodyFieldsFromChallenge(challenge) }),
    {
      status: response.status,
      statusText: response.statusText,
      headers,
    },
  );
}

/** Read a JSON object body, or an empty object when it is absent or malformed. */
async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed = await response.clone().json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
