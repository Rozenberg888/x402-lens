/**
 * x402 v2 wire types, narrowed to what the findings engine needs.
 *
 * These are structural subsets of `@x402/core`'s types. We re-declare them
 * instead of importing so the diagnostics layer stays independent of SDK
 * internals: a change in `@x402/core` cannot silently change a diagnosis, and
 * the engine can run against captured JSON from any implementation.
 */

/** One entry of `PaymentRequired.accepts`. */
export interface WirePaymentRequirements {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

/** `PaymentRequired` as carried in the base64 `PAYMENT-REQUIRED` header. */
export interface WirePaymentRequired {
  x402Version: number;
  error?: string;
  resource?: {
    url?: string;
    description?: string;
    mimeType?: string;
    [key: string]: unknown;
  };
  accepts?: WirePaymentRequirements[];
  extensions?: Record<string, unknown>;
}

/** EIP-3009 authorization inside an EVM `exact` payload. */
export interface WireEvmAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

/** `PaymentPayload.payload` for EVM `exact`. */
export interface WireEvmExactPayload {
  signature: string;
  authorization: WireEvmAuthorization;
}

/** `PaymentPayload` as carried in the base64 `PAYMENT-SIGNATURE` header. */
export interface WirePaymentPayload {
  x402Version: number;
  resource?: WirePaymentRequired["resource"];
  accepted?: WirePaymentRequirements;
  payload?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

/** Facilitator `/verify` response. */
export interface WireVerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  invalidMessage?: string;
  payer?: string;
  extensions?: Record<string, unknown>;
}

/** Facilitator `/settle` response. */
export interface WireSettleResponse {
  success: boolean;
  errorReason?: string;
  errorMessage?: string;
  payer?: string;
  transaction?: string;
  network?: string;
  amount?: string;
  extensions?: Record<string, unknown>;
}

const DECIMAL_POINT = /[.,]/;
const CAIP2_PATTERN = /^[a-z][a-z0-9]{1,31}:[A-Za-z0-9-]{1,64}$/;

/** True when `value` is an integer string, which is what atomic units are. */
export function isAtomicAmount(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0) return false;
  if (DECIMAL_POINT.test(value)) return false;
  return /^\d+$/.test(value);
}

export function isCaip2Network(value: unknown): value is string {
  return typeof value === "string" && CAIP2_PATTERN.test(value);
}

/**
 * Extract the EIP-3009 payload of a `paymentPayload`, if it has one.
 *
 * @param payload - A decoded `PAYMENT-SIGNATURE`
 * @returns The EVM exact payload, or `undefined` when this is not one
 */
export function asEvmExactPayload(
  payload: unknown,
): WireEvmExactPayload | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const inner = (payload as WirePaymentPayload).payload;
  if (typeof inner !== "object" || inner === null) return undefined;
  const candidate = inner as Partial<WireEvmExactPayload>;
  if (typeof candidate.signature !== "string") return undefined;
  const auth = candidate.authorization;
  if (typeof auth !== "object" || auth === null) return undefined;
  if (typeof auth.from !== "string" || typeof auth.to !== "string") {
    return undefined;
  }
  if (typeof auth.value !== "string") return undefined;
  return candidate as WireEvmExactPayload;
}
