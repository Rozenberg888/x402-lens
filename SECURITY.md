# Security policy

`x402-lens` sits on the payment path, so a bug here can cost someone money.
Please report security issues privately rather than in a public issue.

## Reporting

Use GitHub's private vulnerability reporting on this repository
("Security" → "Report a vulnerability"). If that is unavailable, email the
maintainer listed in `package.json` and put `SECURITY` in the subject.

Include:

- what the issue lets an attacker do;
- the version and package (`@x402-lens/core`, `@x402-lens/express`, `x402-lens`);
- a reproduction, ideally a failing test or a captured exchange.

## What counts as a security issue

- A payment accepted without being verified.
- A payment settled for the wrong amount, asset, network, or recipient.
- Findings that report success for a payment that was actually rejected.
- Bypassing `grant` to reach a protected handler.
- Leaking a facilitator token, private key, or buyer address through events,
  logs, or the JSONL sink.
- A sink failure that breaks or stalls the payment path.

## Secrets

Do not put facilitator credentials in `x402.config.json`. That file is often
committed; `loadConfig` rejects any `facilitatorHeaders` key there. Use
`X402_FACILITATOR_TOKEN` or pass `facilitatorHeaders` in code / process env
instead. Routes, network, and `payTo` may stay in the JSON file.

## Settle ambiguity (do not auto-retry)

Trade settlement is at-most-once from the seller's side. After a timeout, a
connection reset, or an ambiguous settle failure (`settlement_pending`, empty
body, 5xx with no clear reject), **do not** resend the same settle — that can
double-charge. Classify the outcome, then confirm on-chain with
`x402-lens reconcile --tx <hash> --network <caip2>` (or your own RPC check)
before asking the buyer to pay again.

## What does not

- A facilitator returning wrong data — that is the facilitator's bug, though a
  finding that fails to surface it is ours.
- Anything in `@x402/*`, `express`, or `viem` — report upstream.
- Denial of service through volume on an unprotected route.

## Response

Acknowledged within 3 working days. A fix and a release follow as fast as the
severity warrants. Credit is given unless you ask otherwise.

## Supported versions

The latest published minor receives fixes. This project is pre-1.0, so that means
the current `0.x` line only.
