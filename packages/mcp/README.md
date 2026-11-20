# @x402-lens/mcp

**x402 v2 payments for MCP tools that explain themselves.**

[`@x402/mcp`](https://www.npmjs.com/package/@x402/mcp) implements the payment
handshake for tool calls. `@x402-lens/mcp` wraps it and adds the part that is
missing in production: a structured event per step, and a diagnosis that tells
you *why* a paid call failed.

An agent calling a paid tool has no operator reading logs. That changes what the
output is for — the diagnosis has to be legible to the model deciding whether to
retry, which is why findings are on the event.

## Install

```bash
npm install @x402-lens/mcp @x402/mcp @x402/core
```

## Use

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { x402ResourceServer } from "@x402/core/server";
import { mcpLens } from "@x402-lens/mcp";

const lens = mcpLens({
  sinks: { console: true, jsonlPath: "events.jsonl" },
});

const search = lens.paidTool({
  server: resourceServer,
  toolName: "search",
  accepts: await resourceServer.buildPaymentRequirements({
    scheme: "exact",
    network: "eip155:84532",
    payTo: "0x2096…",
    price: "$0.01",
  }),
});

server.tool(
  "search",
  "Premium search ($0.01)",
  { query: z.string() },
  search.wrap(async ({ query }) => ({
    content: [{ type: "text", text: await runSearch(query) }],
  })),
);
```

The inner handler runs only after the SDK has verified payment. Without a
payment, the client receives the standard `PaymentRequired` challenge — the same
one `@x402/mcp` produces, so existing clients keep working.

## Why this and not the official wrapper alone

| Question | `@x402/mcp` | `x402-lens` |
| --- | --- | --- |
| Was a payment requested? | the result carries a challenge | `payment.required` event |
| Did it settle, on which tx? | in `_meta` | `payment.settled` with `txHash` |
| Why did it fail? | the SDK throws | `payment.failed` / `payment.settle_failed` with findings |
| Which network was wrong? | you decode the challenge yourself | `network_not_offered` in plain language |

## Events

| Type | Emitted when |
| --- | --- |
| `payment.required` | the tool returned a challenge instead of running |
| `payment.settled` | settlement confirmed, with `txHash` |
| `payment.settle_failed` | settlement failed, with findings |
| `payment.failed` | the call threw with a payment error, including the challenge |

Every event carries `route` (`TOOL <name>`), `scheme`, `network`, `amount`,
`asset`, `payTo`, `offers`, `durationMs`, and `findings` where applicable.

## Refusing a silent free tool

A tool wrapped with an empty `accepts` array never asks for payment. That is a
configuration mistake with a quiet failure mode — the invoice simply never
arrives — so it throws at definition time:

```
[x402-lens] paidTool("search") was given no accepts entries. An empty array
means no payment is ever requested — build requirements with
resourceServer.buildPaymentRequirements(), or leave the tool unwrapped.
```

## Relationship to the HTTP adapters

The Express and Hono adapters share `@x402-lens/server` for the HTTP request
flow. MCP has no HTTP request, so it cannot reuse that flow — but the event
model, findings engine and sinks are the same `@x402-lens/core`, so a deployment
running both reports the same event shapes and alerts on the same finding codes.

## License

MIT
