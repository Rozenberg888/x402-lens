/**
 * Observing the 402 without changing it.
 *
 * The official Express middleware builds `PaymentRequired`, puts it in the
 * base64 `PAYMENT-REQUIRED` header, and sends a small JSON body. There is no
 * hook for "a challenge was issued", so we watch the response instead: wrap the
 * few methods that can commit headers or a body, decode the header, and emit.
 *
 * Everything is restored on `finish`, and nothing we do alters the wire form of
 * the header. The one deliberate addition is to the JSON body: v2 treats the
 * response body as server-defined, and mirroring the challenge there is what
 * makes `curl | jq` usable without base64 in the loop.
 */

import type { Response } from "express";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { WirePaymentRequired } from "@x402-lens/core";
import { bodyFieldsFromChallenge, isChallengeStatus } from "@x402-lens/server";

/** Re-exported so this module stays the one place an adapter imports from. */
export { bodyFieldsFromChallenge };

export interface ObserveOptions {
  /**
   * Mirror the decoded challenge into the 402 JSON body. The v2 spec leaves the
   * body to the server; a readable body is what makes `curl | jq` usable
   * without base64 in the loop. Set false to leave the body untouched.
   */
  mirrorBody?: boolean;
}

type AnyFunction = (...args: unknown[]) => unknown;

interface Patchable {
  setHeader: AnyFunction;
  writeHead: AnyFunction;
  json: AnyFunction;
}

/**
 * Attach an observer to one response.
 *
 * @param res - The Express response to watch
 * @param onChallenge - Called once per 402 that carries a decodable challenge
 * @param options - Whether to mirror the challenge into the body
 * @returns A function that removes the observer early
 */
export function observePaymentRequired(
  res: Response,
  onChallenge: (paymentRequired: WirePaymentRequired) => void,
  options: ObserveOptions = {},
): () => void {
  const mirrorBody = options.mirrorBody ?? true;
  const target = res as unknown as Patchable;
  const originalSetHeader = target.setHeader;
  const originalWriteHead = target.writeHead;
  const originalJson = target.json;

  let captured: WirePaymentRequired | undefined;
  let capturedRaw: string | undefined;
  let emitted = false;
  let restored = false;

  const capture = (value: unknown): void => {
    if (typeof value !== "string" || value.length === 0) return;
    if (value === capturedRaw) return;
    try {
      captured = decodePaymentRequiredHeader(value) as unknown as WirePaymentRequired;
      capturedRaw = value;
    } catch {
      // A malformed header is the SDK's problem to surface, not ours.
    }
  };

  const emitIfChallenge = (): void => {
    if (emitted || !captured) return;
    emitted = true;
    onChallenge(captured);
  };

  target.setHeader = function patchedSetHeader(
    this: unknown,
    name: unknown,
    value: unknown,
  ) {
    if (typeof name === "string" && name.toLowerCase() === "payment-required") {
      capture(value);
    }
    return originalSetHeader.call(this, name, value);
  } as AnyFunction;

  target.writeHead = function patchedWriteHead(
    this: unknown,
    statusCode: unknown,
    ...rest: unknown[]
  ) {
    if (isChallengeStatus(Number(statusCode))) {
      // Some setups pass the header bag to writeHead instead of setHeader.
      for (const candidate of rest) {
        if (candidate && typeof candidate === "object") {
          for (const [key, value] of Object.entries(candidate as Record<string, unknown>)) {
            if (key.toLowerCase() === "payment-required") capture(value);
          }
        }
      }
      emitIfChallenge();
    }
    return originalWriteHead.call(this, statusCode, ...rest);
  } as AnyFunction;

  target.json = function patchedJson(this: unknown, body: unknown, ...rest: unknown[]) {
    if (isChallengeStatus(res.statusCode) && captured) {
      emitIfChallenge();
      if (!mirrorBody) return originalJson.call(this, body, ...rest);
      const base =
        body && typeof body === "object" && !Array.isArray(body)
          ? (body as Record<string, unknown>)
          : {};
      return originalJson.call(this, { ...base, ...bodyFieldsFromChallenge(captured) }, ...rest);
    }
    return originalJson.call(this, body, ...rest);
  } as AnyFunction;

  const restore = (): void => {
    if (restored) return;
    restored = true;
    target.setHeader = originalSetHeader;
    target.writeHead = originalWriteHead;
    target.json = originalJson;
    res.off("finish", restore);
    res.off("close", restore);
  };

  res.on("finish", restore);
  res.on("close", restore);

  return restore;
}
