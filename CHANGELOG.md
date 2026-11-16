# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

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
