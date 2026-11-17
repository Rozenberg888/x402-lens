# Ship paid AI endpoints that explain themselves

**x402-lens** turns an Express route into a micropayment-gated API — and tells you *why* a payment failed instead of leaving you with a silent `402`.

Published packages:

| Package | Install |
| --- | --- |
| Express middleware | `npm i @x402-lens/express` |
| CLI | `npm i -g @x402-lens/cli` |
| Core (diagnostics) | `npm i @x402-lens/core` |

Repo: [github.com/Rozenberg888/x402-lens](https://github.com/Rozenberg888/x402-lens)

---

## The problem

Official `@x402/express` already implements the protocol: challenge, verify, settle. That is enough to charge for a request.

It is not enough to run an **AI endpoint** in production:

- Agents keep getting `402` and you cannot see whether the network, signature, amount, or CORS is wrong.
- A cheap read can settle after the handler; an expensive `/generate` must not.
- `settlement_pending` looks like failure; retrying can charge the buyer twice.
- Browser buyers silently drop `PAYMENT-SIGNATURE` without the right CORS headers.

At 2am you do not need another paywall. You need a diagnosis.

## The benefit

x402-lens wraps the official middleware. You keep the protocol. You gain:

1. **Structured events** for every step (`payment.required` → `verified` → `settled` / `failed`).
2. **Findings with fixes** — stable codes like `network_not_caip2`, `signature_mismatch`, `settlement_pending`.
3. **CLI that works from the outside** — no SDK integration required to smoke-test a paywall.
4. **Safe money movement** — `upfront` for costly AI work, `reconcile` before any retry.

One sentence: **sell AI calls per request, and stop guessing why buyers bounce.**

---

## Who this is for

- Indie hackers and startups monetizing a single AI route (`/generate`, `/embed`, `/image`).
- Teams building **tools for agents** that pay over HTTP 402.
- Anyone already on `@x402/express` who needs observability, not a rewrite.

Any model can sit behind the paywall (OpenAI, Anthropic, Gemini, Ollama, Replicate, …).  
What matters is an **x402-capable client** on the buyer side — agents and SDKs that can answer a `402`, not ChatGPT.com by itself.

---

## 60-second integration

```bash
npm i @x402-lens/express
```

```bash
export X402_FACILITATOR_URL=https://x402.org/facilitator
export X402_NETWORK=eip155:84532
export X402_PAY_TO=0xYourAddress
```

```ts
import express from "express";
import { paymentLens } from "@x402-lens/express";

const app = express();

const lens = paymentLens({
  routes: {
    // Cheap / idempotent: settle after the handler is fine
    "GET /models": "$0.001",
    // AI generation: take money first so you never deliver unpaid compute
    "POST /generate": { price: "$0.05", paymentFlow: "upfront" },
  },
  cors: true, // browser buyers need exposed payment headers
});

lens.on(event => {
  console.log(event.type, event.route, event.network, event.buyer ?? "");
});

app.use(lens.middleware);

app.post("/generate", async (req, res) => {
  // Call any model provider here — OpenAI, Anthropic, local vLLM, …
  res.json({ text: "…" });
});

app.listen(4021);
```

Unpaid requests get a proper `402`. Valid payments reach your handler. Failures emit findings you can alert on.

---

## CLI: value before you change code

```bash
npm i -g @x402-lens/cli

# Is this paywall alive and CORS-ready?
x402-lens inspect https://api.example.com/generate

# Will this config actually accept payments?
x402-lens doctor

# Why did this exchange fail?
x402-lens explain --challenge @challenge.json --payment @payment.json --verify @verify.json

# Settlement pending? Check the chain before retrying.
x402-lens reconcile --tx 0x… --network eip155:84532
```

`inspect` is the best growth hook: someone can verify *their* endpoint from the outside with zero install of your middleware.

---

## Why AI endpoints need `upfront` (and sometimes `upto`)

| Flow | When money moves | Fit |
| --- | --- | --- |
| `authorization` (default) | After a successful handler | Cheap reads, idempotent GETs |
| `upfront` | Before the handler | LLM / image / audio generation |
| `upto` | Ceiling authorized; charge what was used | Metered token usage |

For AI, unpaid compute is pure loss. Prefer **`upfront`**. When the final price depends on token count, use **`upto`** so the buyer signs a ceiling and you settle the real amount.

---

## Production extras (already in 0.2.0)

- **Multi-network** challenges (e.g. Base + Solana) with per-network `payTo`
- **`grant`** — free health checks / internal keys without hiding them from the event stream
- **Exporters** — Prometheus `/metrics`, OpenTelemetry spans, Sentry breadcrumbs (pass handles you already have; no hard deps)
- **Readable 402 bodies** — `curl \| jq` works without base64 archaeology

---

## What you should not expect

- x402-lens does **not** replace `@x402/express` — it wraps it.
- It does **not** invent a facilitator, network, or payout address.
- It does **not** claim “paid” after a `402`.
- Fastify/Hono adapters are not shipped yet (Express first).

---

## Try it

```bash
npx @x402-lens/cli --help
npm i @x402-lens/express
```

Example app in the repo: `examples/express-weather`  
Full reference: [README](../README.md)

If you integrate it, open an issue titled **Integration report** — real failure modes from outside the project are how this gets better.

---

*MIT licensed. Charge for AI calls. Keep the 2am answers.*
