# Production hardening plan (post–0.2.2)

Date: 2026-11-18  
Goal: close residual Critical/High/Medium gaps from full edge-case audit; ship as **0.2.3**.

## Scope

In scope: express middleware lifecycle, grant, config validation, doctor auth, CORS/inspect fidelity, findings sanitization, sinks/env routes, facilitatorHeaders strictness, chaos contract.

Out of scope (later): CDP golden fixtures, second framework, Solana deep findings, PII redaction tier (document only).

## Workstreams

### W1 — Middleware: ready only for paid routes (Critical)
1. Use SDK route match (`requiresPayment`) before `await ready`.
2. Unprotected paths call `next()` without facilitator probe.
3. Run `grant` at lens layer before `ready` (try/catch); on `true` → `next()`; on string → 403; then await ready + inner.
4. Remove duplicate SDK `onProtectedRequest` grant **or** keep only lens-level to avoid double fire.
5. Do not set `initFailure` from per-request inner catch; emit `facilitator.error` without single-fire init latch for runtime.

### W2 — Config integrity (High)
1. `assertLensConfig(config)` when `options.config` is passed.
2. `normaliseRouteInput` / map values: reject non-string non-object with `ConfigError`.
3. `routesFromEnv`: call `assertPath`.
4. When any `facilitatorHeaders` present: require non-empty `verify`+`settle`+`supported` objects.

### W3 — Doctor / inspect (High–Medium)
1. Probe `/supported` with auth headers from loaded config / token.
2. Check every `payToByNetwork` entry.
3. `inspect`: `redirect: "manual"`.
4. `checkCors` / inspect: flag missing ACAO when expose headers present.

### W4 — Observability hygiene (Medium)
1. Truncate `invalidMessage` in findings (≤200).
2. JSONL sink: stderr once on write failure (not silent forever).
3. Chaos verify-500: narrow expected statuses.

### W5 — Release
1. Tests for W1–W4.
2. CHANGELOG 0.2.3, version bump, lockfile.
3. Full gates + commit.

## Success criteria
- Dead facilitator: paid → 502; `/health` unprotected → 200/next.
- `grant: () => true` works with dead facilitator.
- `options.config` with flat headers → ConfigError.
- Doctor against authed facilitator probe uses Bearer.
- 380+ tests green.

## Status (2026-11-18)

W1–W5 implemented in workspace **0.2.3**. See CHANGELOG.
