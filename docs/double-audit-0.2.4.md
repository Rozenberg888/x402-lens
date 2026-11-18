# Double audit — 0.2.4 (2026-11-18)

## Pass 1

- Gates: typecheck + **391** tests green (then fixes).
- Found Medium: OPTIONS+CORS 404, grant `:param`, doctor multi-net schemes,
  trailing slash, empty price/scheme, ACAO merge, false 502 on middleware throw.
- Fixed in-tree; retested → **394** green.

## Pass 2

- Independent re-audit: N-01…N-08 verified fixed.
- New Medium: `paymentFlow` enum gap, untrimmed prices, empty `routesConfig`.
- Fixed; gates: typecheck + **396** tests + build + check:dist + check:pack green.

## Verdict

**Ship-ready with caveats.** Money path hardened. Remaining blocker for Monday
Argus install path: **npm still publishes 0.2.0** — publish `0.2.4`.

Deferred (0.3.0): CDP fixtures, second framework, Solana decode, PII redaction.
