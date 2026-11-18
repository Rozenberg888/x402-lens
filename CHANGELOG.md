# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
