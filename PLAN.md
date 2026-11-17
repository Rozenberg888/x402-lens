# x402-lens — development plan

From working prototype (`0.1.0`) to a product people pay for.

Each stage ends in something verifiable, not in "done". Stages are ordered by
what blocks the next one, not by how interesting the work is.

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done

---

## Where the product actually is

| | State |
| --- | --- |
| Code | 3 packages + 1 example; typecheck clean; tests growing past 160 |
| CI | GitHub Actions (Node × Express matrix + daily live facilitator) |
| Published | `@x402-lens/*` `0.2.0` on npm |
| Remote | `https://github.com/Rozenberg888/x402-lens` |
| Schemes | `exact`, `upto` |
| Frameworks | Express only |
| Diagnostics | EVM + shallow Solana; reconcile for `settlement_pending` |

Stage 1–2 honesty gaps (`eip712_domain_mismatch`, Solana config findings, `upto`)
are closed. Remaining product pressure is distribution: real users, a second
framework adapter, and hosted monitoring (see Monetisation).

---

## Stage 1 — Honesty and automated checks

Ships nothing new; makes the existing claims true and stops regressions.

- [x] **`eip712_domain_mismatch`** — implemented as a real rule: warns when the
      domain has no token name or version, errors when a field is present but not
      a string. Silent for Solana offers, which have no EIP-712 domain.
- [x] **`npm test` in `prepublishOnly`** — the chain is now version check →
      typecheck → build → full test suite. Verified by running it from a package
      directory (plain `npm test` fails there, so it uses `npm --prefix ../..`).
- [x] **CI on GitHub Actions** — `.github/workflows/ci.yml`: Node 20/22/24 ×
      Express 4/5, typecheck, tests, build, a real load of the built CJS and ESM
      entry points, and a `npm pack` inspection. Live facilitator tests live in
      `live.yml` on a daily schedule, never on a PR.
- [x] **`SECURITY.md`** — private reporting, what counts as a security issue on a
      payment path, response times, supported versions.
- [x] **`CHANGELOG.md`** with a `0.1.0` entry, `CONTRIBUTING.md` with the
      invariants a contributor must not break.

**Exit criterion:** CI green on a fresh clone, and every code named in the README
is emitted by a test. — **met locally**; the workflows run once pushed.

## Stage 2 — Make the advertised support real

- [x] **Solana diagnostics.** Added `asSvmExactPayload` plus rules that check what
      is actually checkable without decoding the transaction: a Solana offer must
      advertise a base58 recipient and a base58 mint. This is the exact bug that
      shipped in `0.1.0` (one EVM address reused for Solana) and it is now a
      finding. Deliberately shallow: the payload is a base64 wire transaction, and
      guessing at its instructions would be worse than an honest "not checked".
- [x] **`paymentFlow` as configuration** — `authorization` vs `upfront`, per
      route, forwarded to `accepts[].extra.paymentFlow`. Verified against the real
      middleware: with `upfront` and a failing settle the handler is never called.
- [ ] **CJS smoke test** — done in Stage 1 (`scripts/smoke-dist.mjs`); kept here as
      the reason it exists.
- [ ] **Golden fixtures** — real payloads captured from x402.org and CDP,
      committed under `test/fixtures/`. Catches specification drift before users do.
      — **done for x402.org**: `npm run fixtures:record` writes
      `test/fixtures/recorded/`, and `test/contract.recorded.test.ts` asserts the
      validator agrees with them. Capture from CDP when credentials exist.

**Exit criterion:** a Solana payment failure produces a specific finding, not an
empty list. — **met** for configuration-level failures; transaction-level
inspection needs the Solana SDK and is out of scope by design.

## Stage 3 — Publish and get real feedback

- [x] **GitHub remote, public.** `https://github.com/Rozenberg888/x402-lens`.
      CI green on all six matrix jobs. The first run failed the packaging job
      because the script assumed npm's Windows layout — fixed by discovering the
      path instead, which is exactly the class of bug CI exists to find.
- [x] npm organisation `@x402-lens`, published `0.2.0`:
      `@x402-lens/core`, `@x402-lens/express`, `@x402-lens/cli` (bin `x402-lens`).
      CLI is scoped under the org; unscoped `x402-lens` was blocked by the
      granular token (org-only).
- [x] CLI `--json` on `inspect` / `explain` / `doctor` / `reconcile` — machine
      shape with `exitCode` so CI and agents do not scrape human text.
- [x] Issue template **Integration report** — structured intake for outside
      failure modes (package, framework, facilitator, artifacts).
- [ ] README with copy-paste examples that were actually run.
- [ ] 10–20 real users. Goal is not revenue, it is learning what hurts.

**Exit criterion:** at least three people outside the project have integrated it,
and their failure modes are known.

## Stage 4 — Widen the market

- [ ] **Second adapter** — Fastify or Hono. Core is framework-agnostic already;
      the adapter is a thin layer. One framework means half the market cannot use it.
      — **blocked**: `@x402/fastify` and `@x402/hono` do not exist in the SDK, and
      the Express adapter is the only transport. A second adapter means writing the
      transport integration, not wrapping one.
- [~] **Schemes `upto` and `batch-settlement`.** `upto` is done (EVM + Solana,
      with the flow rules enforced at config time and verified against the live
      facilitator). `batch-settlement` and `auth-capture` are in the SDK but not
      registered here; `upto` was the one with a clear buyer story.
- [x] **Ready-made exporters** — OpenTelemetry spans, Prometheus `/metrics`,
      Sentry breadcrumbs. Zero hard deps: pass the handles you already run.
      Wired through `sinks.prometheus` / `sinks.otel` / `sinks.sentry`.

## Stage 5 — Reconciliation

- [x] **`x402-lens reconcile --tx 0x…`** — asks a public RPC whether the hash
      confirmed (EVM receipt or Solana signature). `settlement_pending` now
      points at this command; terminal settle errors use `settlement_failed`.

---

## Test strategy

The current 161 tests are a good unit baseline but one-sided.

**1. Unit (exists).** Rules engine, config, conformance.

**2. Contract tests against the real SDK (partly exists).**
`integration.express.test.ts` drives the real `@x402/express` with a mock
facilitator — correct approach. Gap: no golden fixtures from real facilitators.

**3. Mutation testing of the findings engine (to add).** For a diagnostic tool
this is not a luxury. The `accepts[0]` bug fixed in `0.1.0` was a green tests
suite over wrong logic; Stryker is what catches the next one.
— **added**. `npm run test:mutation`, thresholds in `stryker.config.mjs`.
Baseline when introduced: 68.75% over `wire`/`conformance`/`config`; now 78%
over those plus `rules.ts`, with 312 tests. `wire.ts` 95%, `conformance.ts` 85%,
`config.ts` 83%, `rules.ts` 74%. It found three real defects (below), not just
missing assertions.

**4. Property-based / fuzz (done).** `fast-check` over `parseJsonOrBase64`,
`asEvmExactPayload`, `asSvmExactPayload`, `diagnose`, and conformance validators.
They must never throw unhandled.

**5. Compatibility matrix.** Node 20/22/24 × Express 4/5 × EVM/SVM × ESM/CJS.

**6. Chaos (done).** Mock facilitator injects 429, 500, hung verify (timeout),
and settle failure after verify. Paid path must never crash the process.

**7. E2E with real money (rare, manual).** Separate suite, not in default CI.
Testnet on every release; mainnet `$0.001` before a major release. Verify the
`PAYMENT-RESPONSE` header, the `txHash` in an explorer, and the **balance
difference** — not just `200 OK`. Settlement happens after the handler runs, so a
200 means goods were delivered, not that money arrived.

**8. Load (done).** Median unpaid 402 path bounded under 50 ms locally; paid path
bounded under 100 ms against the mock facilitator.

**9. CLI snapshot tests (done).** `explain` output snapshotted for signature
mismatch and `settlement_pending`.

**Not worth testing:** facilitator speed (not our code), viem / ed25519
cryptography (not our code).

---

## Monetisation

Honest framing: the competition is a **free** official SDK and free facilitator
dashboards. Do not sell "middleware" — that is given away. Sell what they do not
have.

**Model: open core + hosted service.** Code stays MIT; that is a trust signal a
payment tool cannot buy, and a closed tool loses more in trust than it gains in
revenue. Revenue comes from what is inconvenient to run yourself.

### 1. Synthetic paywall monitoring — the first product

`inspect` already works **from the outside, with no SDK integration**. The
customer changes no code: they give a URL, we check it from several regions every
minute, and alert to Slack when it breaks — the 402 disappeared, a network
vanished from the challenge, CORS regressed, the facilitator stopped listing the
network.

That is "Pingdom for x402". It sells to people who are not ready to adopt an SDK
yet, so the addressable market is wider than the SDK's. It is also the cheapest
way to test whether anyone pays at all.

### 2. Hosted event dashboard

`jsonlFileSink` already emits events. In the cloud that becomes ingestion,
retention windows (30/90/365 days), failure analytics grouped by finding code,
breakdown by route and network, and alerts on a rising `signature_mismatch` rate.
Priced by event volume with tier thresholds.

### 3. Replay / debugger

A captured exchange already replays through `explain` locally. Hosted: search
saved exchanges, "show every payment that failed with `network_not_offered`
today". This is what people pay for during an incident.

### 4. Support, SLA, custom integration

For customers with money at stake. Expensive, but scales with people rather than
code.

### What not to do

- **Sell the middleware itself** — a free competitor sits next to it.
- **Close the source** — a payment tool needs verifiability.
- **Charge per route** — easy to game and irritating to buy.

### Pricing (hypothesis, validate before building)

| Tier | Price | Includes |
| --- | --- | --- |
| Free | $0 | 1 endpoint, 7-day retention |
| Team | ~$49–99 / month | N endpoints, Slack alerts, 90-day retention |
| Business | from volume | Higher retention, SSO, SLA |

The open question is not the number but **whether anyone pays**: x402 is young and
the market may be tiny. Validate that with product 1 — the cheapest of the four —
before investing in the dashboard.

---

## Risks

| Risk | Consequence | Mitigation |
| --- | --- | --- |
| x402 ecosystem stays niche | No market regardless of quality | Validate demand with product 1 before building 2–3 |
| Official SDK adds diagnostics | The core differentiator disappears | Compete on hosted operations, not on the library |
| Bus factor of one | Buying objection for any infrastructure | Document, add a second maintainer before enterprise sales |
| Facilitator API drift | Silent breakage | Golden fixtures + scheduled live tests |
| Payment bug loses customer money | Reputation, liability | Mutation tests, E2E balance checks, `upfront` available, never auto-retry ambiguous settles |

---

## Order of work

1. **Stage 1** — honesty and automated checks. Nothing may be published before this.
2. **Stage 2** — make claimed support real (Solana, `paymentFlow`, CJS).
3. **Stage 3** — publish, then 10–20 users.
4. **Stage 4** — second adapter, `upto`, exporters.
5. **Stage 5** — reconciliation, then monetisation based on feedback.
