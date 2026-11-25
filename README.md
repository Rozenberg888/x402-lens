# x402-lens

**x402 v2 payments for Express that explain themselves.**

`@x402/express` already implements the protocol: it answers 402, sets
`PAYMENT-REQUIRED`, calls the facilitator's `/verify` and `/settle`, and settles
after a successful handler. `x402-lens` does not reimplement any of that. It
wraps it and adds the part that is missing in production: a structured event for
every step, and a diagnosis that tells you *why* a payment failed and what to
change.

**New here?** Read the benefit-first guide:
[Ship paid AI endpoints that explain themselves](https://rozenberg888.github.io/x402-lens/ai-micropayments-with-x402-lens.html)
([source](docs/ai-micropayments-with-x402-lens.md)).

```ts
import express from "express";
import { paymentLens } from "@x402-lens/express";

const app = express();
const lens = paymentLens({ routes: { "GET /weather": "$0.001" } });
lens.on(event => console.log(event.type, event.route, event.network));

app.use(lens.middleware);
app.get("/weather", (_req, res) => res.json({ weather: "sunny", temperature: 70 }));
```

That is the whole integration: one import, one constructor, one mount. Set
`X402_FACILITATOR_URL`, `X402_NETWORK`, and `X402_PAY_TO` and it runs.
Optionally `await lens.ready` before accepting traffic — if the facilitator is
down, it rejects and requests get HTTP 502 with a stable
`{ error: "facilitator_unavailable", code: "FACILITATOR_UNAVAILABLE" }` body
plus a `facilitator.error` event (full detail in the event, not the body)
instead of an opaque 500.

## Why this and not the official middleware alone

The official middleware gives you a working paywall. It does not give you an
answer to "why did this specific request not go through", which is the question
you actually have at 2am. That answer needs three things the protocol does not
carry and the SDK does not emit:

| Question | Official `@x402/express` | `x402-lens` |
| --- | --- | --- |
| Is a payment being requested? | you can read the header | `payment.required` event |
| Was it verified, and by whom paid? | inside the middleware | `payment.verified` with `buyer` |
| Why was it rejected? | `invalidReason` string only | `payment.failed` with findings and fixes |
| Did it settle, on which tx? | in `PAYMENT-RESPONSE` | `payment.settled` with `txHash` |
| Why is the 402 body unreadable? | body is `{}` by design | challenge mirrored into the body |

Two concrete scenarios this catches that the raw SDK does not:

**"Clients keep getting 402 and I do not know why."**

```
$ x402-lens explain --challenge @challenge.json --payment @payment.json \
                     --verify @verify.json

ERROR network_not_caip2
  field:   payment.accepted.network
  problem: payment.network "base-sepolia" is a shorthand, not the CAIP-2 id the server matches on.
  fix:     Use "eip155:84532".

ERROR network_not_offered
  field:   payment.accepted.network
  problem: The client signed for "base-sepolia", but the challenge only offers: eip155:84532.
  fix:     Pick one of the offered networks and re-sign against that accepts[] entry.
```

**"Is my paywall correct from the outside?"**

```
$ x402-lens inspect https://api.example.com/weather

GET https://api.example.com/weather → HTTP 402
Challenge: PAYMENT-REQUIRED header
x402Version: 2
accepts:     1
  [0] exact on Base Sepolia (eip155:84532)
      amount: 1000 (atomic units)
      payTo:  0x2096...
```

## Positioning against the existing tools

- **`@x402/express`** — the protocol. `x402-lens` depends on it and never
  duplicates it. If the SDK fixes something, this package inherits the fix.
- **`create-x402`, `create-x402-app`, `x402magic`** — scaffolders. They create
  a new project. `x402-lens add` edits the server file you already have, prints
  a diff first, and refuses anything it cannot rewrite safely. Running it again
  for a second route extends the existing `routes` map rather than duplicating
  the middleware.
- **Facilitator-hosted dashboards** — see one facilitator's traffic. The event
  stream here is facilitator-neutral: it works with `x402.org`, a CDP
  facilitator, or one you run yourself, because the URL is always configuration.

Nothing here forks the protocol. The findings engine reads v2 objects and
matches on `invalidReason` / `errorReason` codes, never on message text, exactly
as the specification requires.

## Packages

| Package | What it is |
| --- | --- |
| `@x402-lens/core` | Events, findings engine, config, sinks. No framework, no SDK. |
| `@x402-lens/server` | Shared adapter internals: servers, schemes, hooks, CORS. Not installed directly. |
| `@x402-lens/express` | `paymentLens()` for Express 4 and 5. |
| `@x402-lens/hono` | `paymentLens()` for Hono 4. |
| `@x402-lens/mcp` | `mcpLens()` for paid MCP tool calls. |
| `@x402-lens/cli` (`x402-lens`) | CLI: `inspect`, `explain`, `doctor`, `reconcile`, `add`. |

## Configuration

Every value is required and has no default. A defaulted facilitator or network
means payments landing on the wrong chain, so the package refuses to guess.

| Setting | Environment | Example |
| --- | --- | --- |
| Facilitator | `X402_FACILITATOR_URL` | `https://x402.org/facilitator` |
| Network (CAIP-2) | `X402_NETWORK` | `eip155:84532` |
| Networks (CAIP-2, comma-separated) | `X402_NETWORKS` | `eip155:84532,solana:EtWT…` |
| Receiving address | `X402_PAY_TO` | `0x2096...` |
| Address for one network | `X402_PAY_TO_<NETWORK>` | `X402_PAY_TO_EIP155_84532=0x2096…` |
| Price per route | `X402_PRICE__<METHOD>_<PATH>` | `X402_PRICE__GET_/weather=0.001` |
| Settlement timeout | `X402_MAX_TIMEOUT_SECONDS` | `60` |
| Facilitator auth | `X402_FACILITATOR_TOKEN` | bearer token for all endpoints |
| Facilitator timeout | `X402_FACILITATOR_TIMEOUT_MS` | `5000` |

A v1 shorthand such as `base-sepolia` is rejected with the CAIP-2 id to use
instead. `x402.config.json` is also read by `paymentLensAsync`, with explicit
options taking precedence over environment over file. Routes in the file may be
an array or the same `"GET /weather"` map you pass in code.
`facilitatorHeaders` must not appear in the JSON file — use
`X402_FACILITATOR_TOKEN` or pass headers in code (`ConfigError` otherwise).

Supported networks: `eip155:*` via `@x402/evm`, `solana:*` via `@x402/svm`. Any
other namespace throws with an explanation and leaves you the `server` handle to
register your own scheme.

### Pricing the same route on several chains

Set `networks` (or `X402_NETWORKS`) and the challenge advertises one `accepts[]`
entry per network, so a buyer pays on whichever chain holds funds:

```ts
paymentLens({
  routes: { "GET /weather": "$0.001" },
  networks: ["eip155:84532", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"],
  payTo: {
    "eip155:84532": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
  },
});
```

**An address only exists on the chain it belongs to.** A single `payTo` string is
accepted across several networks only when every one of them shares the address
format — two EVM chains, for instance. Mixing an EVM chain with Solana requires
one address per network, and the package refuses the alternative rather than
advertising a wallet nobody can pay on that chain. The map accepts a full
network id, a bare namespace (`solana`), or `"*"` as a fallback.

A `"$"` price resolves each chain's own default token and decimals, so the
atomic amounts legitimately differ. That is why an explicit
`{ asset, amount }` price is rejected across multiple networks: a token address
is chain-specific too.

The SDK validates every configured network against the facilitator at startup
and **exits the process** when one is missing. `x402-lens doctor` checks this
before a deploy.

### Facilitating behind an API key

`X402_FACILITATOR_TOKEN` sends `Authorization: Bearer …` to `/verify`,
`/settle`, and `/supported`. For per-endpoint credentials, pass
`facilitatorHeaders: { verify: {...}, settle: {...} }` in code — that per-path
shape is required, a flat headers object is rejected at config time
(`ConfigError`), and the same key in `x402.config.json` is rejected so secrets
stay out of committed files. To replace the client entirely (an in-process
facilitator, a signing proxy), pass `facilitatorClient`.

## Metered pricing with `upto`

`exact` charges the advertised amount. When the real cost is only known after the
work — tokens, compute, anything metered — use `upto`: the buyer authorises a
ceiling and the server charges what was actually used.

```ts
paymentLens({
  routes: {
    "GET /weather": "$0.001",                                   // exact
    "POST /generate": { price: "$0.05", scheme: "upto" },       // pay up to $0.05
  },
});
```

The flow is not yours to choose here — the scheme fixes it per network family:

| Scheme | Network | Flow | Why |
| --- | --- | --- | --- |
| `exact` | any | `authorization` or `upfront` | your choice, per route |
| `upto` | EVM (`eip155:*`) | `authorization` | settles after the handler; permit2 |
| `upto` | Solana (`solana:*`) | `escrow` | runs through a payment channel |

Setting `paymentFlow` on an `upto` route, or `uptoFlow` on an `exact` one, is a
configuration error. That matters more than it looks: `@x402/core` validates
routes during background init and answers a bad combination with
`process.exit(1)`, so the server would die without ever returning a response.
`x402-lens` refuses the combination during config resolution instead, naming the
route and the valid flow.

`batch-settlement` and `auth-capture` exist in the SDK but are not registered by
this package. Use the returned `server` handle to add them.

## When the money moves

By default the middleware verifies, runs your handler, then settles. That means a
settlement failure after a `200` gives the buyer the data and gives you nothing —
fine for a cheap, repeatable read, wrong for anything expensive.

```ts
paymentLens({
  routes: {
    "GET /weather": "$0.001",                              // authorization: settle after
    "POST /generate": { price: "0.05", paymentFlow: "upfront" },  // settle first
  },
});
```

| | `authorization` (default) | `upfront` |
| --- | --- | --- |
| Money before your handler | no | yes |
| Goods without payment | possible | impossible |
| Payment without goods | impossible | possible, needs a refund |
| Fits | cheap idempotent reads | generation, inference, writes |

Choose by which failure costs more. `upfront` is the safe side for anything
non-repeatable; the trade-off is that a handler crash after settlement needs a
refund path. Verified against the real middleware: with `upfront` and a failing
settle, the handler is never called.

## Free access without payment

A route is either paid or free, but real deployments need exceptions: health
checks, internal traffic, a free tier. `grant` runs before verification and
decides per request:

```ts
paymentLens({
  routes: { "GET /weather": "$0.001" },
  grant: ({ header, route }) => header("x-internal-key") === process.env.INTERNAL_KEY,
});
```

Return `true` to let the handler run unpaid, or a string to deny with a 403 and
that reason. Every decision emits `access.granted` / `access.denied`, so a
bypass is never invisible in the event stream. No callback means no bypass path
at all.

## Events

Every event carries `ts`, `requestId`, `route`, `scheme`, `network`, `amount`,
`asset`, `payTo`, and — when known — `buyer`, `txHash`, `phase`, `durationMs`,
and `findings`.

```ts
type LensEvent =
  | { type: "payment.required" }
  | { type: "payment.verified" }
  | { type: "payment.failed"; reason: string }
  | { type: "payment.settled"; txHash: string }
  | { type: "payment.settle_failed"; reason: string; txHash?: string }
  | { type: "payment.canceled"; cancelReason: CancelReason }
  | { type: "facilitator.error"; message: string; status?: number }
  | { type: "access.granted" }
  | { type: "access.denied"; reason: string };
```

`payment.required` is observed from the response headers, because the SDK has no
"challenge issued" hook. The observer only reads; it does not change the wire
form. Everything else comes from the SDK's public lifecycle hooks
(`onAfterVerify`, `onAfterSettle`, `onSettleFailure`, `onVerifiedPaymentCanceled`).

Sinks are composable and a failing sink never breaks a payment:

```ts
import { prometheusHandler, PrometheusRegistry } from "@x402-lens/express";
import { trace } from "@opentelemetry/api";
import * as Sentry from "@sentry/node";

const metrics = new PrometheusRegistry();

paymentLens({
  routes: { "GET /weather": "$0.001" },
  sinks: {
    console: true,                    // compact line per event
    jsonlPath: ".x402-lens/events.jsonl",
    onEvent: event => span.addEvent(event.type, event),
    prometheus: metrics,              // counters + latency summary
    otel: trace.getTracer("x402-lens"),
    sentry: Sentry,
  },
});

app.get("/metrics", prometheusHandler(metrics));
```

OpenTelemetry and Sentry are optional peer surfaces — neither is a dependency of
this package. Pass the handles you already have.

## Why a request did not go through

The engine returns findings ordered by severity, each with a `code`, the `field`
at fault, the `problem`, and a `fix`. Covered causes:

`x402_version_mismatch`, `missing_accepts`, `network_not_caip2`,
`network_not_offered`, `amount_not_atomic`, `amount_mismatch`, `pay_to_mismatch`,
`asset_mismatch`, `eip712_domain_mismatch`, `authorization_expired`,
`authorization_not_yet_valid`, `signature_mismatch`, `settlement_pending`,
`settlement_failed`.

Two of these are worth calling out because they catch bugs no mock surfaces:

- `eip712_domain_mismatch` — the domain is built from `extra.name`,
  `extra.version`, the chain id, and the asset. A missing name or version is what
  makes a signature recover to the wrong address with no explanation.
- `pay_to_mismatch` also fires when a **Solana** offer advertises a recipient
  that is not base58. That offer is unpayable, and the client only discovers it
  when the transaction fails to build.

On Solana the payload is a signed transaction rather than an authorization, so
recipient and amount cannot be read without decoding it. The rules check what is
knowable — address and mint format, network, scheme, amount atomicity — and say
nothing about what they cannot see. An honest gap beats a confident guess.

Browser CORS readiness is a static property of an endpoint rather than a fact
about one payment, so it is reported by `x402-lens inspect` and `checkCors`, not
as a runtime finding.

An unrecognised facilitator code is never swallowed: it surfaces as a warning
naming the code, so a new error does not silently become "unknown failure".

### Settlement is not delivery

`settlement_pending` is treated as **non-terminal**. The transaction was
broadcast and may still confirm, so the advice is to reconcile on chain, not to
retry:

```
x402-lens reconcile --tx 0x… --network eip155:84532
```

`settlement_failed` is terminal — funds did not move. `x402-lens` never claims a
payment was delivered after a 402.

## Browser buyers

None of the three payment headers is CORS-safelisted. A cross-origin `fetch()`
cannot read `PAYMENT-REQUIRED`, and the browser strips `PAYMENT-SIGNATURE` from
the retry — the payment silently never happens. `x402-lens inspect` reports
this. To fix it from this package:

```ts
paymentLens({ routes: { ... }, cors: { origin: "https://app.example.com" } });
```

Off by default, because an app with its own CORS middleware should own this.
When enabled, headers are merged with whatever the response already has.

## CLI

```
x402-lens inspect <url> [--method GET] [--header "K: V"] [--timeout 15000] [--json]
x402-lens explain [--challenge ...] [--payment ...] [--verify ...] [--settle ...] [--json]
x402-lens doctor [--facilitator <url>] [--network <caip2>] [--json]
x402-lens reconcile --tx <hash> [--network <caip2>] [--rpc <url>] [--json]
x402-lens add "<METHOD> <path>" --file <path> --price <amount> [--write]
```

All of `--challenge`, `--payment`, `--verify`, `--settle` accept raw base64
header values, decoded JSON, or `@file`. `--json` prints a stable machine shape
(always includes `exitCode`) for CI and agents. `doctor` exits non-zero when the
facilitator does not list the configured network for `x402Version: 2`, so it can
gate a deploy. `reconcile` asks a public RPC whether a settlement hash confirmed
— use it after `settlement_pending`, never retry first. `add` prints a diff and
only writes with `--write`.

## Development

```bash
npm install
npm run typecheck
npm test            # unit + integration + chaos + property + load, no network
npm run test:live   # hits https://x402.org/facilitator
npm run test:mutation  # mutation score on the core, ~8 minutes (requires Stryker ≥10; `vitest.pool: forks` on Windows)
npm run fixtures:record # re-record golden fixtures from the real middleware
npm run example     # accepts x402 payments on localhost:4021
```

Tests run against package sources, so a stale build cannot mask a regression.
The integration suite drives the real `@x402/express` middleware against a mock
facilitator and asserts the three acceptance criteria: 402 on no payment, 402
without the handler on an invalid one, 200 with settlement on a valid one.
`inspect` and `doctor` are exercised against real HTTP servers, since their
value is the exit code that gates a deploy.

## What this deliberately does not do

- Fork the protocol or add non-standard fields to `PaymentRequired` /
  `PaymentPayload`.
- Implement its own facilitator client, or override verify and settle.
- Support every framework. Express only; the core package is framework-agnostic
  if you want to write another adapter.
- Default the facilitator, network, or receiving address.
- Promise delivery after a 402.

## License

MIT.
