# x402-lens — development plan

From a working diagnostic layer to a product people depend on.

Each stage ends in something verifiable, not in "done". Stages are ordered by
what blocks the next one, not by how interesting the work is.

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done

---

## Where the product actually is

Measured **2026-11-25** from this repository; npm download figures from
**2026-11-20** (registry; refresh before quoting externally).

| | State |
| --- | --- |
| Packages | 6 workspaces: `core`, `server`, `express`, `hono`, `mcp`, `cli` |
| Published on npm | `0.2.4` for `core`/`express`/`cli`. `server`, `hono`, `mcp` unpublished |
| Version in repo | `0.2.5` (tag/publish pending — see `docs/RELEASE-0.2.5.md`) |
| Tests | **759** passing (`npm test`, 2026-11-25) |
| Mutation | Stryker **10.1.1**, `pool: "forks"`, `ignoreStatic` — **76.10%** (2026-11-25, ~25 min) |
| Frameworks | Express 4/5 and Hono 4, sharing one payment path via `@x402-lens/server` |
| Schemes | `exact`, `upto`, plus `extraSchemes` |
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

Published and adopted are different problems, and only the second one is real.
Publishing gives availability; it does not create demand. A new adapter nobody
asked for does not become wanted by appearing in `npm search`.

- [~] **Patch 0.2.5 for what already shipped.** Fixes from the `0.2.4` audit
      (grant `reason` truncation, `extraSchemes` error text, middleware 500 vs
      false 502) are on `feat/hono-adapter`; workspace version is **0.2.5**.
      **Remaining:** `npm login`, `npm run release`, publish `core`/`express`/`cli`
      per `docs/RELEASE-0.2.5.md` (2026-11-25).
- [ ] **Leave the three new packages unpublished until someone asks.** `server`,
      `hono` and `mcp` have no external users and no API contract. That is fine
      while nobody has them; afterwards every breaking change is somebody else's
      broken deploy. Publishing to feel finished is the opposite of finished.
      (Still true at 0.2.5 — checklist defaults to patch-only publish.)
- [ ] **One public artefact.** A failure mode written up with the actual event
      JSON, not a changelog entry. This is what answers "does anyone want the
      Hono or MCP adapter", and it costs nothing but writing. The Argus report
      proved the shape: an independent tester ran 21 sealed scenarios, found two
      real gaps, and produced more external validation than four releases did.
- [ ] **Reach ten real users.** The goal is not revenue; it is learning what
      breaks. Success is one issue report from someone whose repository is not
      this one.
- [x] **Fix the `PLAN.md` habit.** Three times this file asserted something false
      (missing adapters; a shared package Express did not use; publishing as the
      blocker for everything). Each claim now carries a date and a source, and a
      checked box means the artefact exists and was verified — not that it was
      intended. Statements about priority are dated too, because they age.

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

- [x] **Synthetic paywall monitoring.** `x402-lens watch <url...>` checks from
      the outside — no SDK on the monitored server — and reports drift against
      the previous check: a network removed from `accepts`, `payTo` changed, a
      price moved, the challenge gone entirely. The comparison is "would a client
      that paid successfully before still be able to pay now", which an uptime
      check cannot answer. (2026-11-23)
- [x] **Weekend MVP first.** Slack alerting via `--slack` or
      `X402_LENS_SLACK_WEBHOOK`, one channel and one format, failure returned
      rather than thrown. State is persisted through a temp file and rename so a
      killed run cannot erase the baseline. (2026-11-23)
- [ ] **Price it before building it.** If nobody will pay for twenty URLs
      checked every minute, the dashboard behind it will not sell either.
      **Cannot be done from this repository.** It needs a person to ask, and the
      number to be quoted.

**Exit criterion:** one paying customer, or a documented reason nobody pays.

---

## Stage 4 — Close the remaining honesty gaps

Not features; places where the package implies more than it does.

- [x] **Solana transaction-level inspection.** Resolved to the useful half.
      Instruction-level parsing is still refused on purpose: it needs the Solana
      program definitions, `@x402/svm` brings six dependencies into a package
      that promises "no framework, no SDK", and a wrong guess about a transfer
      instruction produces a confident false finding. What is checked now is the
      envelope, which needs no SDK and cannot be wrong that way:
      `transaction_not_base64` (a client sending raw bytes, a JSON array or a
      truncated string — today this surfaces as an opaque facilitator
      `invalid_reason`) and `transaction_too_short` (valid base64 that cannot be
      a signed transaction). (2026-11-23)
- [x] **`batch-settlement` and `auth-capture`.** Resolved, but not by adding
      them to configuration. Reading their types showed why that cannot work:
      both need runtime objects — channel storage for `batch-settlement`, an
      authorizer signer for `auth-capture` — which an environment variable cannot
      express. Instead `extraSchemes` accepts the built instance, so any SDK
      scheme works, including ones newer than this release.
      This also fixed a real dead end: the unsupported-namespace error told the
      reader to call `server.register(...)` themselves, which was impossible —
      the throw happens before the caller ever sees the server. (2026-11-23)
- [x] **CDP facilitator fixtures.** Not a gap this repository can close: CDP's
      facilitator answers `401` without an API key (verified 2026-11-23 against
      `api.cdp.coinbase.com/platform/v2/x402/supported`), so there is nothing to
      record without credentials. Recording a fixture requires access, not code.
      What the investigation did surface is a real defect, now fixed: `doctor`
      reported a 401 as `facilitator reachable: FAIL` and then advised "Fix the
      FAIL lines above", sending the operator to check the URL and the network
      where nothing was wrong. A 401 is now its own `facilitator auth` check and
      says the facilitator is up but requires credentials.

---

## Test strategy

759 tests, and the parts that matter most are the ones that are not units.

**1. Unit.** Rules engine, config, conformance. Mutation-tested (threshold **81%**;
dry-run verified on Windows with `vitest.pool: "forks"` — 2026-11-25); the
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
