# Release 0.2.5 — checklist

Verified in-repo **2026-11-25** on branch `feat/hono-adapter`.

## Pre-flight (local)

- [x] `npm run check:versions`
- [x] `npm run typecheck`
- [x] `npm test` (759 tests)
- [x] `npx stryker run --dryRunOnly` (Windows: `vitest.pool: "forks"` in `stryker.config.mjs`)
- [x] `npm run test:mutation` (76.10% — see below)
- [ ] `npm run release` (build + `check:dist` + `check:pack`)

## Publish to npm

Prerequisite: `npm whoami` must succeed (not 401).

### Patch lane (already on registry)

Ship together at **0.2.5** (order matters — `npm run publish:npm`):

- [ ] `@x402-lens/core`
- [ ] `@x402-lens/server` (**first publish** — required because `express@0.2.5` depends on it)
- [ ] `@x402-lens/express`
- [ ] `@x402-lens/cli`

`prepublishOnly` on express refuses to upload if `server@0.2.5` is not on the registry yet.

### New packages (optional — hold unless someone asks)

First publish = new API contract:

- [ ] `@x402-lens/hono`
- [ ] `@x402-lens/mcp`

Default per `PLAN.md`: **hold** until an external integration asks.

## After publish

- [ ] Tag `v0.2.5` and push
- [ ] Open/update GitHub release notes from `CHANGELOG.md`
- [ ] One public artefact: failure-mode write-up with real event JSON (Argus-style)

## Mutation score (2026-11-25, local Windows)

```
Stryker 10.1.1, ignoreStatic: true, vitest.pool: forks
Duration: 24m 34s
Mutation score: 76.10% total, 78.94% covered
Killed / survived / no cov / timeout: 1817 / 485 / 86 / 1
Report: reports/mutation/index.html, reports/mutation/mutation.json
```

`vitest.stryker.config.ts` drops `test/scripts.publish-guard.test.ts` (real `npm` + registry) from the Stryker sandbox run.