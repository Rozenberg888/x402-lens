/**
 * Event model emitted by x402-lens.
 *
 * Every event is a flat, JSON-serialisable record. The required fields come
 * straight from the brief: `route`, `amount`, `network`, `buyer`, `tx_hash`.
 * Extras exist because without them the record cannot answer "why did this
 * request fail" — which is the whole point of the package.
 */

/** A single diagnosis produced by the findings engine. */
export interface Finding {
  /** `error` blocks the payment; `warn` is suspicious; `info` is context. */
  severity: "error" | "warn" | "info";
  /** Stable identifier, safe to alert or filter on. */
  code: FindingCode;
  /** Dotted path of the field the finding is about, e.g. `payment.network`. */
  field: string;
  /** What is wrong, in plain language. */
  problem: string;
  /** What to change so the next request succeeds. */
  fix: string;
}

/** Stable finding codes. Never rename — consumers filter on these. */
export type FindingCode =
  | "x402_version_mismatch"
  | "missing_accepts"
  | "network_not_caip2"
  | "network_not_offered"
  | "amount_not_atomic"
  | "amount_mismatch"
  | "pay_to_mismatch"
  | "asset_mismatch"
  | "eip712_domain_mismatch"
  | "authorization_expired"
  | "authorization_not_yet_valid"
  | "signature_mismatch"
  | "settlement_pending";

/** Reasons core reports when a verified payment is never settled. */
export type CancelReason =
  | "handler_threw"
  | "handler_failed"
  | "after_verify_aborted"
  | "settlement_preflight_failed";

/** Which settle invocation is running (multi-settle flows fire hooks twice). */
export type SettlePhase = "before-handler" | "after-handler" | "cancel";

export type PaymentEventType =
  | "payment.required"
  | "payment.verified"
  | "payment.failed"
  | "payment.settled"
  | "payment.settle_failed"
  | "payment.canceled"
  | "facilitator.error"
  | "access.granted"
  | "access.denied";

/** Fields present on every event. */
export interface LensEventBase {
  /** ISO 8601 timestamp of the event. */
  ts: string;
  /** Correlation id. Identical for every event of one HTTP exchange. */
  requestId: string;
  /** `"<METHOD> <path>"`, e.g. `"GET /weather"`. */
  route: string;
  /** Payment scheme, e.g. `"exact"`. */
  scheme: string;
  /** CAIP-2 network id, e.g. `"eip155:84532"`. */
  network: string;
  /** Amount in atomic units, as it appears on the wire. */
  amount: string;
  /** Token contract address (EVM) or mint (SVM). */
  asset: string;
  /** Recipient address advertised in `accepts[]`. */
  payTo: string;
  /** Payer address, when known. */
  buyer?: string;
  /** Settlement phase for multi-settle flows. */
  phase?: SettlePhase;
  /** Milliseconds since the request entered the middleware. */
  durationMs?: number;
  /**
   * How many payment options the challenge advertised.
   *
   * A challenge can offer the same route on several networks; the base fields
   * describe the first entry, and this says how many others exist.
   */
  offers?: number;
  /** Diagnoses attached to this event. */
  findings?: Finding[];
}

export type LensEvent =
  | (LensEventBase & { type: "payment.required"; error?: string })
  | (LensEventBase & { type: "payment.verified" })
  | (LensEventBase & { type: "payment.failed"; reason: string })
  | (LensEventBase & { type: "payment.settled"; txHash: string })
  | (LensEventBase & {
      type: "payment.settle_failed";
      reason: string;
      txHash?: string;
    })
  | (LensEventBase & { type: "payment.canceled"; cancelReason: CancelReason })
  | (LensEventBase & {
      type: "facilitator.error";
      message: string;
      status?: number;
    })
  | (LensEventBase & { type: "access.granted" })
  | (LensEventBase & { type: "access.denied"; reason: string });

export type LensEventType = LensEvent["type"];

/**
 * Build a fully-formed event, filling protocol defaults so callers never have
 * to think about them.
 */
export function makeEvent<T extends LensEvent>(
  event: Omit<T, "ts"> & { ts?: string },
): T {
  return {
    ts: new Date().toISOString(),
    ...event,
  } as T;
}
