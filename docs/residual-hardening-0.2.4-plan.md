# Residual hardening plan (post–0.2.3 → 0.2.4)

Date: 2026-11-18  
Source: residual audit after W1–W5 (`3debd33`)  
Goal: close High/Medium residuals that still bite production / Argus; keep 0.3.0 expansion deferred.

## Verdict

**Ready with caveats.** Money-path W1–W5 is in-tree. Remaining blockers: npm still at **0.2.0** (ops), incomplete `assertLensConfig`, stub `grant.config`, docs/`cors: true` without ACAO.

## Scope

### In — 0.2.4

| ID | Severity | Work |
|---|---|---|
| R-01 | Critical (ops) | Publish after code (or publish 0.2.3 then 0.2.4) — separate gate |
| R-02 | High | `assertLensConfig` parity with `resolveConfig` (URL, payTo, paths) |
| R-03 | High | Populate `GrantContext.config` with matched route |
| R-04 | Medium | `assertPath` on array `{ method, path, price }` form |
| R-05 | Medium | Docs + example: `cors: { origin }`; README honesty for `cors: true` |
| R-06 | Medium | Top-level `.catch` on middleware async IIFE |
| R-07 | Medium | Skip payment for `OPTIONS` (preflight) |
| R-08 | Medium | Doctor: scheme checks from `config.routes`, not always `exact` |
| R-09 | Medium | Grant string deny: stable buyer body; detail only on event |
| R-10 | Medium | Enter request ALS before grant/ready (correlation) |
| R-11 | Medium | Settle ambiguity: short SECURITY/README runbook (no auto-retry) |
| R-12 | Medium | Reject blank facilitator header values |
| R-13 | Low | Inspect: explicit 3xx / redirect finding |
| R-14 | Low | Document `await lens.ready` in express README |

### Out — 0.3.0+ (do not start in 0.2.4)

| ID | Item | Why deferred |
|---|---|---|
| O-01 | CDP golden fixtures | Needs CDP credentials / recorded payloads |
| O-02 | Second framework (Fastify/Hono) | Blocked on `@x402/*` adapters |
| O-03 | Solana deep findings | Needs optional `@solana/web3.js` + fixtures |
| O-04 | PII redaction tier | Product/ops feature, not money-path bug |

## Workstreams

### W1 — Config integrity (R-02, R-04, R-12)
1. Expand `assertLensConfig`: `assertUrl(facilitatorUrl)`, payTo / `payToByNetwork` shape per network, `assertPath` on every route path.
2. In `normaliseRouteArray` direct form: `assertPath` + reject missing path.
3. In `assertFacilitatorHeadersShape`: reject empty-string header values.

### W2 — Middleware / grant (R-03, R-06, R-07, R-09, R-10)
1. Resolve matched route → pass as `GrantContext.config`.
2. Wrap middleware async body in `.catch` → 502 + `facilitator.error` (or 500 stable body) if unexpected.
3. Short-circuit `OPTIONS` with `next()` (or 204 + CORS) before payment.
4. String grant deny → `{ error: "access_denied" }` to buyer; full reason on event only.
5. `runWithRequestContext` around grant + ready + inner (not only inner).

### W3 — Doctor / inspect / docs (R-05, R-08, R-11, R-13, R-14)
1. Doctor: collect schemes from `config.routes`; check each against `/supported` kinds.
2. Inspect: when status is 3xx, finding names redirect (do not follow).
3. Example + README + guide: `cors: { origin: "…" }`; document that `cors: true` is expose-only.
4. Document `await lens.ready` fail-fast.
5. Short settle-ambiguity runbook: never auto-retry settle; use `reconcile --tx`.

### W4 — Release
1. Tests for W1–W3.
2. CHANGELOG 0.2.4, `npm run version:set 0.2.4`, lockfile.
3. Full gates + commit.
4. Publish only when user explicitly asks (R-01).

## Success criteria

- `paymentLens({ config })` with bad `payTo` / unrooted path / blank Bearer → `ConfigError`.
- `grant` callback receives route price/metadata; string deny does not leak reason to buyer.
- `OPTIONS` never hits payment/ready.
- Example `inspect` passes CORS (ACAO set).
- Doctor green for `upto`-only configs when facilitator lists `upto`.
- 390+ tests green; workspace `0.2.4`.

## Approaches (choose one)

| | Approach | Pros | Cons |
|---|---|---|---|
| **A** | **0.2.4 full residual** (W1–W4 above) — **recommended** | Closes High+Medium footguns; Argus-safe tree | Larger patch; publish still separate |
| **B** | **Minimal 0.2.4** — only R-02, R-03, R-05 + publish | Fastest to Monday | Leaves OPTIONS/grant leak/doctor schemes |
| **C** | **0.3.0 expansion** — start O-01…O-04 | Product breadth | Wrong for Argus; high risk/time |

## Status

Approach **A** implemented in workspace **0.2.4**. Publish still a separate gate (R-01).
