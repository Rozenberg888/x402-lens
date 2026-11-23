# x402-lens — development plan

From a working diagnostic layer to a product people depend on.

Each stage ends in something verifiable, not in "done". Stages are ordered by
what blocks the next one, not by how interesting the work is.

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done

---

## Where the product actually is

Measured 2026-11-20 from the npm registry and this repository. Numbers, not
impressions — the previous version of this file contained a claim that
`@x402/fastify` and `@x402/hono` did not exist, which had been false for weeks
and blocked the most valuable work in Stage 4.

| | State |
| --- | --- |
| Packages | 5: `core`, `server`, `express`, `hono`, `cli` |
| Published on npm | `0.2.4` for `core`/`express`/`cli`. `server` and `hono` are unpublished |
| Tests | 427 passing, plus mutation testing at 78% on the findings engine |
| Frameworks | Express 4/5 and Hono 4, sharing one payment path via `@x402-lens/server` |
| Schemes | `exact`, `upto` |
| Diagnostics | EVM and shallow Solana; `reconcile` for `settlement_pending` |

### Market position, honestly

| Package | Downloads/month |
| --- | --- |
| `@x402/core` | 2 413 959 |
| `@x402/hono` | 257 126 |
| `@x402/express` | 229 229 |
| `@x402/next` | 90 350 |
| `@x402/paywall` | 62 492 |
| `@x402/mcp` | 46 880 |
| `@x402/fastify` | 4 538 |
| **`@x402-lens/core`** | **459** |
| **`@x402-lens/express`** | **463** |

The x402 ecosystem is large; the lens is 0.02% of it. The gap is not features —
it is that nobody knows the package exists. Four releases in one week, eight
audits closed, and zero outside integrations. Further code is not the constraint.

One competitor exists in this exact niche: `@ledgergate/ledgergate-sdk`, an
"x402 Observability SDK" at 23 downloads/month since March 2026. The niche is
empty not because nobody tried, but because nobody has sold it.

---

## Stage 1 — Distribution (the only thing that matters now)

Everything else is blocked on this. A fifth adapter does not help if the first
four reach 459 people.

- [ ] **Publish `@x402-lens/server`, `@x402-lens/hono`, `@x402-lens/mcp`.**
      All three are unpublished as of 2026-11-20 (`npm view` → not found), so
      three quarters of the work is unusable outside this repository.
      Requires `npm login`; `npm whoami` returns 401 on this machine, which is
      why 0.2.4 sat unreleased for two days.
      **Blocks every other item in every stage.**
- [ ] **Reach ten real users.** The goal is not revenue; it is learning what
      breaks. Success is one issue report from someone whose repository is not
      this one.
- [ ] **One public artefact per release.** A failure mode written up with the
      actual event JSON, not a changelog entry. The Argus report proved this
      works: an independent tester ran 21 sealed scenarios and found two real
      gaps, which is more external validation than any changelog produced.
- [x] **Fix the `PLAN.md` habit.** Twice this file asserted something false
      (missing adapters; a shared package Express did not use), and it then sat
      at 0 of 12 boxes while the MCP adapter was finished. Each claim now
      carries a date, and a checked box means the artefact exists and was
      verified — not that it was intended.

**Exit criterion:** three integrations outside this repository, and their
failure modes are known and documented.

---

## Stage 2 — The MCP segment

`@x402/mcp` has 46 880 downloads/month and no diagnostic tooling at all. The
pain is sharper there than in an HTTP server: an agent receives a 402 and has no
developer sitting next to it to interpret `invalidReason`.

- [x] **`@x402-lens/mcp`.** `mcpLens().paidTool()` + `tool.wrap(handler)`. MCP
      returns a challenge inside a tool result rather than an HTTP 402, so the
      HTTP request flow could not be reused — but the event model, findings and
      sinks are the same `@x402-lens/core`. The handshake stays with the SDK's
      `createPaymentWrapper`; a guard test forbids `fetch(` / `verify(` /
      `settle(` in the adapter so a second implementation cannot creep in.
      (2026-11-20)
- [x] **Agent-readable findings.** Answered, and the answer is "some, not all".
      A `payment.*` finding describes the caller's own payload — it signed for a
      network the challenge does not offer, its authorization expired — and the
      caller can fix that and retry. A `challenge.*` finding describes the
      challenge this server generated, which the caller cannot repair; sending it
      would send an agent into a retry loop it cannot escape. `agentFindings()`
      keeps the first and drops the second, because sending all findings and
      sending none are both wrong.
      Delivered as an extra `content` item, never merged into
      `structuredContent`: clients validate that field as `PaymentRequired`, so
      adding to it would break every conformant client to help some.
      (2026-11-20)

**Exit criterion:** an MCP server can report "why did this tool call fail to
pay" without the operator reading raw facilitator output.
— **met (2026-11-20).** Verified end to end: an expired authorization produces
`ERROR authorization_expired (payment.authorization.validBefore): The
authorization expired at … Fix: Request a fresh 402 …` as a second content item,
with the challenge unchanged in the first.

---

## Stage 3 — Monitoring without SDK adoption

`inspect` already works from the outside, with no integration. That is the only
product sellable to someone who has not adopted anything yet, and the cheapest
way to test whether anyone pays at all.

- [ ] **Synthetic paywall monitoring.** A URL, checked from several regions every
      minute, alerting when: the 402 disappears, a network vanishes from the
      challenge, CORS regresses, or the facilitator stops listing the network.
- [ ] **Weekend MVP first.** Cron plus a Slack webhook, twenty URLs. Do not
      build ingestion or retention until someone asks for it.
- [ ] **Price it before building it.** If nobody will pay for twenty URLs
      checked every minute, the dashboard behind it will not sell either.

**Exit criterion:** one paying customer, or a documented reason nobody pays.

---

## Stage 4 — Close the remaining honesty gaps

Not features; places where the package implies more than it does.

- [ ] **Solana transaction-level inspection.** Current Solana support checks the
      advertised recipient and mint, nothing inside the base64 wire transaction.
      That is honest and documented, but `exact` on Solana is a large share of
      the ecosystem and "not checked" is a weaker answer than "checked".
      Needs the Solana SDK — a real dependency cost, so it is a decision, not a
      task.
- [ ] **`batch-settlement` and `auth-capture`.** Both exist in the SDK and are not
      registered here. `upto` was the one with a clear buyer story; these need
      one too before they earn code.
- [ ] **CDP facilitator fixtures.** Golden fixtures exist for `x402.org` only.
      A capture from CDP would catch spec drift in the second-largest
      facilitator before users do.

---

## Test strategy

427 tests, and the parts that matter most are the ones that are not units.

**1. Unit.** Rules engine, config, conformance. Mutation-tested at 78%; the
`accepts[0]` bug in `0.1.0` was a green suite over wrong logic, which is what
Stryker exists to catch.

**2. Contract tests against the real SDK.** `integration.express.test.ts` and
`integration.hono.test.ts` drive the real `@x402/express` and `@x402/hono`
middleware against a mock facilitator. This is the layer that would have caught
the "Express does not use the shared package" defect — except the defect was in
the wiring, not the behaviour, so the test that catches it is a source-level
assertion. See below.

**3. Architecture assertions.** The duplication that shipped twice suggests a
test, not a convention: assert that the adapters import the shared functions
rather than defining them. Cheap, and it catches exactly the mistake that got
made.

**4. Golden fixtures.** Recorded payloads from real facilitators, asserted
against the validator. Catches specification drift before users do.

**5. Live facilitator tests.** Daily schedule, never on a PR.

---

## Monetisation

Honest framing: the competition is a **free** official SDK and free facilitator
dashboards. Do not sell middleware — that is given away. Sell what they do not
have.

**Model: open core plus hosted service.** Code stays MIT; that is a trust signal
a payment tool cannot buy.

1. **Synthetic paywall monitoring** — "Pingdom for x402". Sells to people not
   ready to adopt an SDK, so the addressable market is wider than the SDK's.
2. **Hosted event dashboard** — `jsonlFileSink` already emits the events. In the
   cloud that becomes ingestion, retention, failure analytics by finding code,
   and alerts on a rising `signature_mismatch` rate.
3. **Replay / debugger** — a captured exchange already replays through `explain`
   locally. Hosted: search saved exchanges during an incident.
4. **Support and SLA** — for customers with money at stake. Scales with people,
   not code.

### What not to do

- **Sell the middleware** — a free competitor sits next to it.
- **Close the source** — a payment tool needs verifiability.
- **Charge per route** — easy to game and irritating to buy.
- **Add networks for the sake of it** — CAIP-2 already accepts any namespace;
  `eip155`, `solana`, `algorand`, `aptos`, `stellar`, `hedera`, `xrpl` validate
  today.

---

## Risks

| Risk | Why it matters | Mitigation |
| --- | --- | --- |
| The niche stays empty because nobody buys | 459 downloads after four releases is evidence, not noise | Price Stage 3 before building it |
| Drift between adapters | Two payment paths that disagree is the worst possible defect | One shared package, plus an architecture test |
| npm publishing stays blocked | Unpublished work is not a product; 0.2.4 already sat for two days | `npm login` is a prerequisite for every release, not an afterthought |
| Solana stays shallow | "Not checked" on a large share of the ecosystem | Decide explicitly in Stage 4, do not drift into it |

---

## Order of work

1. Publish `server` and `hono` (Stage 1) — unblocks the adapter entirely.
2. Architecture test for adapter wiring (Stage 2 tests) — cheap, prevents a
   repeat of a mistake already made twice.
3. `@x402-lens/mcp` (Stage 2) — the largest underserved segment.
4. Synthetic monitoring MVP (Stage 3) — tests whether anyone pays.
5. Stage 4 items only when a customer asks for one.
