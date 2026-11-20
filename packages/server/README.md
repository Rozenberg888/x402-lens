# @x402-lens/server

Shared server-side primitives for x402-lens framework adapters.

You do not normally install this package directly — it is a dependency of
[`@x402-lens/express`](https://www.npmjs.com/package/@x402-lens/express) and
[`@x402-lens/hono`](https://www.npmjs.com/package/@x402-lens/hono). Install one
of those instead.

## Why it exists

Express mutates a `res` object; Hono returns a `Response`. Those are different
enough that one middleware cannot serve both, but everything underneath —
building the resource server, registering schemes, attaching the lifecycle
hooks, and turning SDK callbacks into lens events — is identical.

Keeping that half here is what stops the two adapters from drifting apart on a
payment path: a fix to event shaping reaches every framework at once, and the
adapters stay small enough to read in one sitting.

## What is in it

| Export | Purpose |
| --- | --- |
| `buildServers` | Builds `x402ResourceServer` + `x402HTTPResourceServer` and owns the single `ready` probe |
| `attachHooks` | Turns SDK verify/settle callbacks into `payment.*` events |
| `registerScheme` | Registers `exact` (and `upto` when configured) per network |
| `buildCorsHeaders`, `mergeCorsHeaders` | The three headers a browser buyer needs, merged without duplicating singleton values |
| `runWithRequestContext`, `currentRequestContext` | Per-request context (request id, start time) for hooks that only receive a path |
| `buildSinks` | Console, JSONL, callback, Prometheus, OpenTelemetry, Sentry |
| `matchRouteConfig`, `pathMatchesPattern` | `:param` / `*` route matching for grant callbacks |
| `safeCall` | Treats a throwing adapter accessor as "not available" instead of a 500 |

## Using it to write an adapter

The adapter keeps the request flow and delegates the rest:

```ts
import { buildServers, attachHooks } from "@x402-lens/server";

const { server, httpServer, ready, bus } = buildServers(config, options);
// ... your framework's request handling, then:
await ready;
```

Nothing in this package imports a framework, and nothing decides policy — the
adapter owns the request, this package owns the payment plumbing.

## License

MIT
