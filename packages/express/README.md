# `@x402-lens/express`

Express integration for [x402-lens](../../README.md): x402 v2 payments with
observability that explains itself.

This is a thin layer over `@x402/express`. The official middleware owns the
protocol; this package attaches events, a readable 402 body, and findings.

```ts
import express from "express";
import { paymentLens } from "@x402-lens/express";

const app = express();
const lens = paymentLens({ routes: { "GET /weather": "$0.001" } });
lens.on(event => console.log(event.type, event.route, event.network));

app.use(lens.middleware);
```

Configuration comes from `X402_FACILITATOR_URL`, `X402_NETWORK`, and
`X402_PAY_TO` unless passed explicitly. None of them has a default. Use
`paymentLensAsync` to also read `x402.config.json`.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `routes` | required | `{ "GET /weather": "$0.001" }` or `RouteInput[]` |
| `facilitatorUrl`, `network`, `payTo` | env | Required, no defaults |
| `networks` | `[network]` | Advertise one `accepts[]` entry per network |
| `payTo` as a map | — | One address per network (`{ "eip155:84532": "0x…" }`) |
| `sinks` | console | `{ console, jsonlPath, onEvent }` |
| `extraSinks` | — | Additional `LensSink` implementations |
| `readableBody` | `true` | Mirror the challenge into the 402 JSON body |
| `cors` | `false` | Expose payment headers for browser buyers |
| `grant` | — | `(request) => boolean \| string` to allow or deny unpaid |
| `facilitatorClient` | — | Replace the SDK HTTP client entirely |
| `routesConfig` | — | Override the `RoutesConfig` handed to `@x402/express` |

## Handles

`paymentLens()` returns `middleware`, the underlying `server` and `httpServer`
(for custom hooks or schemes on networks this package does not register),
`config`, `on(listener)`, and `close()`.

## CORS

Off by default: an app with its own CORS layer should own it. When a browser
buys from a different origin, none of the three payment headers is
CORS-safelisted, so payments fail silently. `x402-lens inspect` detects this;
`cors: true` fixes it, merging with any headers already set.

## Several networks on one route

`networks: ["eip155:84532", "solana:…"]` advertises one `accepts[]` entry per
chain, so a buyer pays on whichever chain holds funds. Each entry carries its
own `payTo`: an address exists on one chain only, so mixing an EVM chain with
Solana needs a map, and the package refuses to advertise an EVM address on
Solana.

```ts
paymentLens({
  networks: ["eip155:84532", "solana:EtWT…"],
  payTo: { "eip155:84532": "0x2096…", "solana:EtWT…": "9WzD…" },
  routes: { "GET /weather": "$0.001" },
});
```

A `"$"` price resolves each chain's own token and decimals, which means the
atomic amounts differ by design. An explicit `{ asset, amount }` price is
therefore rejected when more than one network is configured.

The SDK validates every configured network against the facilitator at startup
and exits the process if one is missing. Run `x402-lens doctor` in CI.

## Free access

`grant` runs before verification on each protected request. Return `true` for
access without payment, or a string to deny with a 403 and that reason. Both
decisions emit events (`access.granted`, `access.denied`), so a bypass is
visible rather than silent.
