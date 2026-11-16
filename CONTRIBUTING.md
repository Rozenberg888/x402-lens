# Contributing

## Setup

```bash
npm install
npm run typecheck
npm test
```

Tests import package **sources** through a Vitest alias, so a stale `dist` cannot
mask a regression and you never need to build to run them.

## Before opening a pull request

```bash
npm run release
```

That runs typecheck, tests, build, a load check on the built entry points, and a
`npm pack` inspection. CI runs the same on Node 20/22/24 against Express 4 and 5.

## Ground rules

- **Never break the protocol.** No non-standard fields in `PaymentRequired` or
  `PaymentPayload`, no forked facilitator client.
- **Match on codes, not text.** Findings branch on `invalidReason` /
  `errorReason`; human-readable messages are free-form per the spec.
- **`diagnose()` is read-only.** It must never mutate its input — people run it on
  a live request and on captured production JSON.
- **A failing sink never breaks a payment.** Anything on the event path must
  swallow its own errors.
- **A finding needs a negative test.** A diagnostic that reports a problem on a
  correct payment is worse than no diagnostic, so every new rule needs a case
  proving it stays quiet.
- **Never claim delivery after a 402.** `settlement_pending` is non-terminal;
  advice is to reconcile, not retry.

## Adding a finding

1. Add the code to `FindingCode` in `packages/core/src/events.ts` — codes are
   stable and consumers filter on them, so never rename one.
2. Add the rule in `packages/core/src/findings/rules.ts` with `severity`, the
   dotted `field` at fault, a `problem`, and a `fix` someone can act on.
3. Test it in `test/findings.test.ts`, including the case where it must stay
   silent.
4. Document it in `README.md` — a documented code that is never emitted is a
   support ticket.

## Adding an adapter

`@x402-lens/core` is framework-agnostic. An adapter supplies the framework
middleware, a request id, and the mount; it should not contain diagnosis logic.
See `packages/express/src/observe.ts` for how the 402 is observed without
changing the wire format.

## Commits

Present tense, explaining **why** rather than restating the diff. One logical
change per commit.
