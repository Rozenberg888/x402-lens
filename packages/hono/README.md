# @x402-lens/hono

**x402 v2 payments for Hono that explain themselves.**

[`@x402/hono`](https://www.npmjs.com/package/@x402/hono) already implements the
protocol: it answers 402, sets `PAYMENT-REQUIRED`, calls the facilitator's
`/verify` and `/settle`, and settles after a successful handler. `@x402-lens/hono`
does not reimplement any of that. It wraps it and adds the part that is missing
in production: a structured event for every step, and a diagnosis that tells you
*why* a payment failed and what to change.

## Install

```bash
npm install @x402-lens/hono hono
```

## Use

```ts
import { Hono } from "hono";
import { paymentLens } from "@x402-lens/hono";

const app = new Hono();
const lens = paymentLens({ routes: { "GET /weather": "$0.001" } });
lens.on(event => console.log(event.type, event.route, event.network));

app.use("*", lens.middleware);
app.get("/weather", c => c.json({ weather: "sunny", temperature: 70 }));

export default app;
```

That is the whole integration: one import, one constructor, one mount. Set
`X402_FACILITATOR_URL`, `X402_NETWORK`, and `X402_PAY_TO` and it runs.

Optionally `await lens.ready` before accepting traffic — if the facilitator is
down, it rejects and requests get HTTP 502 with a stable
`{ error: "facilitator_unavailable", code: "FACILITATOR_UNAVAILABLE" }` body
plus a `facilitator.error` event.

## Why this and not the official middleware alone

The official middleware gives you a working paywall. It does not give you an
answer to "why did this specific request not go through", which is the question
you actually have at 2am.

| Question | Official `@x402/hono` | `x402-lens` |
| --- | --- | --- |
| Is a payment being requested? | you can read the header | `payment.required` event |
| Was it verified, and by whom paid? | inside the middleware | `payment.verified` with `buyer` |
| Why was it rejected? | `invalidReason` string only | `payment.failed` with findings and fixes |
| Did it settle, on which tx? | in `PAYMENT-RESPONSE` | `payment.settled` with `txHash` |
| Why is the 402 body unreadable? | body is `{}` by design | challenge mirrored into the body |

## Events

Every event carries `ts`, `requestId`, `route`, `scheme`, `network`, `amount`,
`asset`, `payTo`, and `durationMs`.

| Type | Emitted when |
| --- | --- |
| `payment.required` | a 402 challenge was issued |
| `payment.verified` | the facilitator accepted the payment |
| `payment.failed` | verification was rejected, with findings |
| `payment.settled` | settlement confirmed, with `txHash` |
| `payment.settle_failed` | settlement failed, with findings |
| `payment.canceled` | a verified payment was never settled |
| `facilitator.error` | the facilitator could not be reached |
| `access.granted` / `access.denied` | a `grant` callback decided |

## Configuration

Every value is required and has no default. A defaulted facilitator or network
means payments landing on the wrong chain, so the package refuses to guess.

| Setting | Environment | Example |
| --- | --- | --- |
| Facilitator | `X402_FACILITATOR_URL` | `https://x402.org/facilitator` |
| Network (CAIP-2) | `X402_NETWORK` | `eip155:84532` |
| Networks (comma-separated) | `X402_NETWORKS` | `eip155:84532,solana:EtWT…` |
| Receiving address | `X402_PAY_TO` | `0x2096...` |

## Differences from the Express adapter

Only one, and it is worth knowing: Hono middleware returns a `Response` instead
of mutating one, so `readableBody` rebuilds the JSON response rather than
patching `res.json`. Everything else — events, findings, grants, CORS, readiness
— behaves identically, because both adapters share `@x402-lens/server`.

## License

MIT
