/**
 * Recover a settle response from the error thrown into `onSettleFailure`.
 *
 * The SDK wraps a failed `/settle` as `SettleError`, with `errorReason`,
 * `transaction`, `payer`, and `network` on the error itself — not nested under
 * `settleResponse`. Older or alternate wrappers may still nest the body; both
 * shapes are accepted so diagnosis keeps working either way.
 */

import type { WireSettleResponse } from "./wire.js";

const PATH_NESTED_KEYS = ["settleResponse", "result", "body"] as const;

/**
 * Extract a `WireSettleResponse` from an `onSettleFailure` error, or `undefined`
 * when the thrown value carries no settle fields.
 */
export function settleResponseFromError(error: unknown): WireSettleResponse | undefined {
  if (!error || typeof error !== "object") return undefined;

  const candidate = error as Record<string, unknown>;

  for (const key of PATH_NESTED_KEYS) {
    const nested = candidate[key];
    const fromNested = asSettleResponse(nested);
    if (fromNested) return fromNested;
  }

  return settleErrorFieldsToResponse(candidate);
}

function asSettleResponse(value: unknown): WireSettleResponse | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;

  if (typeof record.success === "boolean") {
    return {
      success: record.success,
      ...optionalSettleFields(record),
    };
  }

  // Nested bag without an explicit success flag still counts if it looks like
  // a settle failure payload (errorReason present).
  return settleErrorFieldsToResponse(record);
}

/**
 * Duck-type `SettleError` (and similar): fields live on the error, `success` is
 * absent. Force `success: false` so `diagnose` treats it as a failed settlement.
 */
function settleErrorFieldsToResponse(
  record: Record<string, unknown>,
): WireSettleResponse | undefined {
  const looksLikeSettleError =
    typeof record.errorReason === "string" ||
    record.name === "SettleError";

  if (!looksLikeSettleError) return undefined;

  // A successful settle is never delivered as SettleError. If a nested body
  // already set success:true, asSettleResponse handled it above.
  if (record.success === true) return undefined;

  return {
    success: false,
    ...optionalSettleFields(record),
    ...(typeof record.errorReason === "string"
      ? { errorReason: record.errorReason }
      : {}),
  };
}

function optionalSettleFields(
  record: Record<string, unknown>,
): Partial<WireSettleResponse> {
  return {
    ...(typeof record.errorReason === "string"
      ? { errorReason: record.errorReason }
      : {}),
    ...(typeof record.errorMessage === "string"
      ? { errorMessage: record.errorMessage }
      : {}),
    ...(typeof record.payer === "string" ? { payer: record.payer } : {}),
    ...(typeof record.transaction === "string"
      ? { transaction: record.transaction }
      : {}),
    ...(typeof record.network === "string" ? { network: record.network } : {}),
    ...(typeof record.amount === "string" ? { amount: record.amount } : {}),
  };
}
