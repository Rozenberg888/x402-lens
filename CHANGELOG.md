# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.4] — 2026-11-18

### Changed (upgrade note)

- `grant` string denies now always return `{ error: "access_denied" }` to the
  buyer; the reason string is only on the `access.denied` event.
- Docs and the weather example use `cors: { origin }` instead of `cors: true`
  (`cors: true` never set `Access-Control-Allow-Origin`).

### Fixed

- `assertLensConfig` now mirrors `resolveConfig` for URL, payTo, paths, multi-
  network asset prices, and blank facilitator header values.
- Array route form `{ method, path, price }` rejects unrooted / missing paths.
- `grant` receives the matched route as `request.config` (including
  `/users/:id`-style patterns).
- `OPTIONS` never waits on facilitator readiness; with `cors` enabled the lens
  answers preflight with HTTP 204 + CORS headers (browser-safe).
- Unexpected middleware failures return HTTP 500 `MIDDLEWARE_ERROR` (not a
  false facilitator 502).
- Pre-built `config` facilitator URLs strip trailing slashes like `resolveConfig`.
- `assertLensConfig` rejects empty prices, unknown schemes, and bad
  `paymentFlow`/`uptoFlow`; trims whitespace on hand-built string prices.
- Empty `routesConfig: {}` throws `ConfigError` (would silently unprotect).
- CORS merge replaces `Access-Control-Allow-Origin` (never comma-joins it).
- Request ALS starts before grant/ready so hooks share `requestId`.
- `x402-lens doctor` checks schemes from configured routes on **every**
  configured network (not only the primary).
- `x402-lens inspect` names 3xx redirects instead of a generic “no challenge”.
- Example package is a workspace member on `@x402-lens/express@0.2.4`.
- Settle ambiguity runbook added to `SECURITY.md` (never auto-retry settle).

## [0.2.3] — 2026-11-18

### Changed (upgrade note)

- When `facilitatorHeaders` is set, `verify`, `settle`, and `supported` must each
  be a non-empty header map. Partial objects (e.g. settle-only) are now
  `ConfigError` at config time.

### Fixed

- Unprotected routes no longer await facilitator readiness; a dead facilitator
  no longer blocks `/health` (and similar) behind a global 502.
- `grant` runs before facilitator readiness so internal bypass still works when
  the facilitator is down.
- `paymentLens({ config })` re-validates via `assertLensConfig` (headers, CAIP-2,
  schemes, routes) instead of trusting a pre-built object.
- Route map values that are neither a string nor an options object throw
  `ConfigError` instead of a generic `Error`.
- `x402-lens doctor` probes `/supported` with auth headers from config and
  checks every `payToByNetwork` entry.
- `x402-lens inspect` uses `redirect: "manual"` so a 302 cannot hide a 402.
- `checkCors` flags missing `Access-Control-Allow-Origin` when payment CORS
  headers are otherwise present.
- Facilitator `invalidMessage` text in findings is truncated to 200 characters.
- JSONL sink write failures are reported once on stderr.

## [0.2.2] — 2026-11-18

### Changed (upgrade note)

- `facilitatorHeaders` in `x402.config.json` now throws `ConfigError`. Put
  facilitator auth in `X402_FACILITATOR_TOKEN` or `paymentLens({ facilitatorHeaders })`
  instead — the JSON file must not hold secrets.

### Fixed

- `x402.config.json` accepts the map form of `routes`
  (`{ "GET /weather": "$0.001" }`), matching the object form `paymentLens()`
  already took. A value that is neither an array nor a map is now a
  `ConfigError` naming the accepted shapes instead of a raw `raw.map is not a
  function`.
- Unreachable facilitator no longer becomes an opaque HTTP 500 with an empty
  event stream. `paymentLens()` exposes `ready`, emits `facilitator.error`, and
  answers buyers with HTTP 502 + a stable
  `{ error: "facilitator_unavailable", code: "FACILITATOR_UNAVAILABLE" }` body
  (full SDK detail stays on the event only).
- `x402-lens add` emits route/price as `JSON.stringify` literals so a crafted
  `--price` cannot break out of the string.
- `x402-lens doctor` reports a dedicated `facilitatorHeaders` check (flat shape
  or secrets in `x402.config.json`) and does not skip it when `--facilitator` /
  `--network` overrides are present.

## [0.2.1] — 2026-11-17

### Changed (upgrade note)

- A flat `facilitatorHeaders` object now throws `ConfigError` while the app is
  being configured, so the process exits at startup. Previously the SDK
  rejected it on the first payment request, which reached the buyer as HTTP 500.
  If you currently pass flat headers, fix the shape before upgrading.

### Fixed

- `payment.settle_failed` events now carry populated `findings` by recovering
  the settle body from SDK `SettleError` fields (`errorReason` / `transaction`
  on the error itself), matching CLI `explain --settle` depth (Argus Lab seal
  0023).
- Flat `facilitatorHeaders` (e.g. `{ Authorization: "…" }`) throw `ConfigError`
  at config time instead of surfacing as HTTP 500 on the first payment request.

## [0.2.0] — 2026-11-17

### Added

- Ready-made exporters: `prometheusSink` / `prometheusHandler`,
  `openTelemetrySink`, `sentryBreadcrumbSink` (no hard dependencies on those
  stacks — pass the handles you already have).
- `x402-lens reconcile --tx <hash>` — on-chain confirmation check for
  `settlement_pending` (EVM + Solana public RPCs).
- `settlement_failed` finding code for terminal settle errors (was incorrectly
  labelled `settlement_pending`).
- Scheme `upto` (EVM + Solana) with flow rules enforced at config time.
- Chaos, property (`fast-check`), load-overhead, exporter, reconcile, and CLI
  snapshot tests.
- `npm run publish:npm` — ordered publish (core → express → cli).

### Fixed

- Terminal settle failures no longer share the `settlement_pending` code, so
  alerts that filter on that code stop treating hard failures as in-flight.
- `validatePayloadAgainstChallenge` no longer throws on non-object input.

## [0.1.0]

First release.

### Added

- `@x402-lens/core` — `diagnose()` findings engine, event model, config
  resolution, conformance checks, and sinks (console, JSONL file, callback).
- `@x402-lens/express` — `paymentLens()` and `paymentLensAsync()` on top of
  `@x402/express`, with a readable 402 body, CORS readiness, and events for every
  lifecycle step.
- `x402-lens` CLI — `inspect`, `explain`, `doctor`, `add`.
- Pricing the same route on several networks, with one receiving address per
  network.
- `grant` hook for letting a request through without payment, emitting
  `access.granted` / `access.denied`.
- Facilitator auth headers and request timeout.
- `eip712_domain_mismatch` finding for an incomplete or malformed EIP-712 domain.

### Fixed

- Amount and `payTo` findings compared every payment against `accepts[0]`, so a
  client that correctly chose a second offered network received two false errors.
  The comparison now uses the entry the payment echoes.
- One `payTo` was reused for every configured network, so a Solana offer
  advertised an EVM address that no one can pay. Addresses are now resolved and
  format-checked per network.
- `x402-lens add` reported "nothing to do" for a route the file merely mentioned,
  leaving the route unprotected. It now extends the existing `routes` map.
