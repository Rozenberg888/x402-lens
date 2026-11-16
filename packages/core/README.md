# `@x402-lens/core`

Framework-agnostic core for [x402-lens](../../README.md): payment events, the
findings engine, configuration, conformance checks, and sinks.

Nothing here knows about Express or about `@x402/core`, so the diagnostics work
against captured JSON, inside a test, or from the CLI.

```ts
import { diagnose, validatePaymentRequired, resolveConfig } from "@x402-lens/core";

const findings = diagnose({
  paymentRequired,   // decoded PAYMENT-REQUIRED
  paymentPayload,    // decoded PAYMENT-SIGNATURE
  verifyResponse,    // facilitator /verify result
  settleResponse,    // facilitator /settle result
});
```

Every entry is optional: pass whatever subset of the exchange you captured.

## Configuration has no defaults

`resolveConfig` and `loadConfig` throw `ConfigError` when the facilitator URL,
network, or receiving address is missing. They never fall back to a public
facilitator or mainnet, and they reject v1 shorthands such as `base-sepolia`
with the CAIP-2 id to use instead.

## Read-only by contract

`diagnose` never mutates its input, so it can run against a live request or
against production JSON. Findings match on `invalidReason` / `errorReason`
codes, never on message text, because the specification makes that text
free-form.

## Prices are compared per offer, not per challenge

A challenge may advertise several `accepts[]` entries — the same route priced in
USDC on Base and on Solana is the normal case — each with its own amount, asset,
and recipient. Amount and `payTo` findings are therefore computed against the
entry the payment echoes, not against `accepts[0]`: paying the second offer is
correct, and reporting it as a mismatch would send an operator chasing a bug
that does not exist. Only when the payment names an entry the challenge does not
offer is the comparison skipped, because `network_not_offered` already names the
real problem. Every offer is still validated independently for atomic amounts,
so a broken second offer cannot hide behind a working first one.

## Prices: `"$"` amounts or explicit assets

A decimal string is dollar-pegged: the SDK resolves the network's default token
and converts to atomic units. `{ asset, amount }` states the token and the atomic
amount directly, for a non-stablecoin or a token with no default on that network.

An explicit asset price is refused when several networks are configured, because
a token address exists on one chain only — picking one silently would mis-price
every other chain. Use a `"$"` price there, so each chain resolves its own token.
