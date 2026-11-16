# `x402-lens` CLI

Explain and verify x402 v2 payments. See the [main README](../../README.md) for
the full picture.

```bash
x402-lens inspect <url> [--method GET] [--header "K: V"] [--timeout 15000]
x402-lens explain [--challenge ...] [--payment ...] [--verify ...] [--settle ...]
x402-lens doctor [--facilitator <url>] [--network <caip2>] [--networks <a,b>]
x402-lens reconcile --tx <hash> [--network <caip2>] [--rpc <url>]
x402-lens add "<METHOD> <path>" --file <path> --price <amount> [--write]
```

## inspect

Fetches an endpoint unpaid, decodes `PAYMENT-REQUIRED`, validates it against the
v2 schema, and reports CORS readiness for browser buyers. Exits non-zero when
anything is wrong, so it works as a smoke test in CI.

## explain

Takes any subset of a failed exchange and prints findings ordered by severity,
each with the field at fault and a fix. Arguments accept raw base64 header
values, decoded JSON, or `@file`.

## doctor

Verifies that configuration can accept payments: CAIP-2 format, address shape,
facilitator reachability, and that `GET /supported` lists the configured network
with `x402Version: 2` and the `exact` scheme. Exits non-zero on any failure.

With more than one network configured it also checks every one of them, because
the SDK validates them all at startup and **exits the process** if any is
missing — a failure that returns no 402 and no error response, only a server that
stopped. Run `doctor` in CI so that cannot reach production.

## reconcile

Asks a public RPC whether a settlement transaction confirmed. Use after
`settlement_pending` — never retry the payment until you know. Supports
`eip155:*` (receipt status) and `solana:*` (signature lookup). Pass `--rpc` to
override the default public endpoint.

## add

Adds protection to an existing Express route. Prints a unified diff by default;
`--write` applies it. Idempotent, and it refuses non-Express files or routes it
cannot rewrite safely rather than guessing.

Adding a second route to a server that already calls `paymentLens()` extends
the existing `routes` map in place — same indentation, same trailing-comma
style — instead of mounting a second middleware. The array form
(`routes: [{ route, price }]`) and computed route maps are refused with the
exact snippet to paste, because rewriting them can change what is protected.

Requires `X402_FACILITATOR_URL`, `X402_NETWORK`, and `X402_PAY_TO` at runtime:
`paymentLens()` will not start without them.
