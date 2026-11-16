# x402-lens — development plan

From working prototype (`0.1.0`) to a product people pay for.

Each stage ends in something verifiable, not in "done". Stages are ordered by
what blocks the next one, not by how interesting the work is.

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done

---

## Where the product actually is

| | State |
| --- | --- |
| Code | 3 packages + 1 example, 161 tests, clean typecheck |
| CI | none — no `.github` directory |
| Published | no, everything is `0.1.0` |
| Remote | none, repository is local only |
| Bundle | core 40 KB, express 13 KB, cli 33 KB |
| Schemes | `exact` only |
| Frameworks | Express only |
| Diagnostics | EVM-only |

Three findings that drive the ordering below:

1. **A documented diagnostic does not exist.** `eip712_domain_mismatch` is
   declared in `packages/core/src/events.ts` and promised in `README.md:228`,
   but has zero occurrences in the rules engine. That is a false promise, not a
   missing feature.
2. **Solana diagnostics are effectively absent.** All four payload-reading rules
   go through `asEvmExactPayload`, so for a Solana payment `checkPayTo` and
   `checkAuthorizationWindow` return `[]` and the amount check degrades to
   challenge validation only. The package claims `solana:*` support but cannot
   answer "why did this fail" on Solana — which is the entire product.
3. **The public facilitator offers more than the package can use.** `/supported`
   lists `upto` and `batch-settlement` on Base Sepolia; `x402-lens` hardcodes
   `scheme: "exact"`.

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
- [ ] npm organisation `@x402-lens`, verify names are free, publish in dependency
      order: core → express → cli. **Deferred by decision** — the names are free
      (`npm view` returns 404 for both) and no npm session exists yet.
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
- [ ] **Ready-made exporters** — OpenTelemetry spans and metrics, Prometheus
      `/metrics`, Sentry breadcrumbs. For an observability product, "write your
      own `onEvent`" is a weak offer.

## Stage 5 — Reconciliation

- [ ] **`x402-lens reconcile --tx 0x…`** — `settlement_pending` currently advises
      "reconcile on chain" with no tool to do it. This is literally the 2am the
      README talks about, so it is the strongest single feature available.

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

**4. Property-based / fuzz (to add).** `parseJsonOrBase64`, `asEvmExactPayload`
and `validatePaymentRequired` take untrusted input from users and the network.
`fast-check` over truncated JSON, broken base64, huge numbers, unexpected nulls.
These must never throw unhandled.

**5. Compatibility matrix.** Node 20/22/24 × Express 4/5 × EVM/SVM × ESM/CJS.

**6. Chaos.** The mock already fails `/supported`. Add: 429 with retry, 500,
facilitator timeout, and settle succeeding after the handler already responded —
the latter is the most dangerous case.

**7. E2E with real money (rare, manual).** Separate suite, not in default CI.
Testnet on every release; mainnet `$0.001` before a major release. Verify the
`PAYMENT-RESPONSE` header, the `txHash` in an explorer, and the **balance
difference** — not just `200 OK`. Settlement happens after the handler runs, so a
200 means goods were delivered, not that money arrived.

**8. Load.** Overhead per request. An observability layer must not cost a
millisecond. Without this number, selling "transparency" is not credible.

**9. CLI snapshot tests.** `inspect` / `explain` output is the UX; an accidental
format change breaks users' scripts.

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
