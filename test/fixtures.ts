/**
 * Fixtures for the findings engine.
 *
 * Shapes mirror real wire objects: an EVM `exact` challenge on Base Sepolia and
 * the `PaymentPayload` a client signs against it. Tests mutate one field at a
 * time so each rule is exercised in isolation.
 */

import type {
  WirePaymentPayload,
  WirePaymentRequired,
  WireEvmExactPayload,
} from "@x402-lens/core";

export const BASE_SEPOLIA = "eip155:84532";
export const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
export const PAYER = "0x857b06519E91e3A54538791bDAbd0E22373e36b66";

/** `2025-02-27T16:01:40Z`, inside the fixture authorization window. */
export const NOW = 1740672100 * 1000;

export function challenge(overrides: Partial<WirePaymentRequired> = {}): WirePaymentRequired {
  return {
    x402Version: 2,
    resource: {
      url: "https://api.example.com/weather",
      description: "Weather data",
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: BASE_SEPOLIA,
        amount: "10000",
        asset: USDC_BASE_SEPOLIA,
        payTo: PAY_TO,
        maxTimeoutSeconds: 60,
        extra: { name: "USDC", version: "2" },
      },
    ],
    ...overrides,
  };
}

export function evmPayloadBody(
  overrides: Partial<WireEvmExactPayload["authorization"]> = {},
): WireEvmExactPayload {
  return {
    signature: `0x${"ab".repeat(65)}`,
    authorization: {
      from: PAYER,
      to: PAY_TO,
      value: "10000",
      validAfter: "1740672089",
      validBefore: "1740672154",
      nonce: `0x${"cd".repeat(32)}`,
      ...overrides,
    },
  };
}

export function paymentPayload(
  overrides: Partial<WirePaymentPayload> = {},
): WirePaymentPayload {
  return {
    x402Version: 2,
    resource: { url: "https://api.example.com/weather" },
    accepted: {
      scheme: "exact",
      network: BASE_SEPOLIA,
      amount: "10000",
      asset: USDC_BASE_SEPOLIA,
      payTo: PAY_TO,
      maxTimeoutSeconds: 60,
      extra: { name: "USDC", version: "2" },
    },
    payload: evmPayloadBody() as unknown as Record<string, unknown>,
    ...overrides,
  };
}

/** A payload whose authorization is overridden, keeping the rest intact. */
export function payloadWithAuth(
  authorization: Partial<WireEvmExactPayload["authorization"]>,
  overrides: Partial<WirePaymentPayload> = {},
): WirePaymentPayload {
  return paymentPayload({
    payload: evmPayloadBody(authorization) as unknown as Record<string, unknown>,
    ...overrides,
  });
}
