/**
 * Mutation testing for the findings engine and the payment path.
 *
 * Ordinary coverage cannot tell the difference between a test that checks an
 * outcome and one that merely executes the code. The `accepts[0]` bug that
 * shipped in 0.1.0 had a green suite: every test passed the code through, none
 * asserted the comparison used the entry the client chose.
 *
 * Two groups are mutated, for different reasons:
 *
 * - The diagnostics (`core`) are the product: a wrong finding costs a user
 *   hours, while a wrong sink name costs nothing.
 * - The shared payment path (`server`) is what both adapters run. A mutant that
 *   survives there means a change to how a payment is observed, routed, or
 *   rejected can ship without any test noticing — and it would ship to Express
 *   and Hono at once, which is the reason the package exists.
 */
export default {
  dryRunTimeoutMinutes: 20,
  // 47% of mutants are static strings/consts; skipping them keeps local runs
  // under an hour while per-test coverage still exercises behavioural mutants.
  ignoreStatic: true,
  testRunner: "vitest",
  mutate: [
    "packages/core/src/findings/rules.ts",
    "packages/core/src/config.ts",
    "packages/core/src/conformance.ts",
    "packages/core/src/wire.ts",
    "packages/server/src/index.ts",
  ],
  vitest: {
    configFile: "vitest.stryker.config.ts",
    // Stryker defaults to `threads`; on Windows that pool can hang the initial
    // test run. Vitest's own CLI uses `forks` — match that here (Stryker ≥10).
    pool: "forks",
    related: false,
  },
  // Every mutant must run the whole suite: a finding is only wrong if some test
  // notices, and most rules are covered by tests in a different file.
  disableTypeChecks: "packages/**/*.ts",
  reporters: ["clear-text", "progress", "html", "json"],
  htmlReporter: { fileName: "reports/mutation/index.html" },
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  thresholds: {
    // A threshold below the current score silently allows regressions, so this
    // is a floor, not a goal — and it has to sit at the measured score, not
    // under it. At `break: 70` with the suite scoring 73, roughly twenty killed
    // mutants could be lost before the gate noticed, which is a whole broken
    // rule passing CI. Measured 2026-11-25 (Stryker 10, ignoreStatic, forks):
    // 76.10% total / 78.94% covered — floor set to that score until survivors
    // in rules.ts and server/index.ts are killed.
    high: 90,
    low: 80,
    break: 76,
  },
  timeoutMS: 20000,
  concurrency: 4,
// Generated output and test files are not inputs to the product.
//
// `test/fixtures/recorded` is deliberately NOT ignored. It was, and Stryker's
// ignore pattern also skips copying, so the sandbox had no fixtures and
// `contract.recorded.test.ts` died at import with ENOENT — the dry run failed
// before a single mutant ran, which is why this package's adapters had never been
// mutation-tested. Recorded fixtures are inputs: the whole point is that they do
// not change between runs.
ignorePatterns: ["dist", "coverage", "reports"],
};
