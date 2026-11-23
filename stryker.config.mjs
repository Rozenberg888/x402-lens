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
  testRunner: "vitest",
  mutate: [
    "packages/core/src/findings/rules.ts",
    "packages/core/src/config.ts",
    "packages/core/src/conformance.ts",
    "packages/core/src/wire.ts",
    "packages/server/src/index.ts",
  ],
  vitest: {
    configFile: "vitest.config.ts",
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
    // rule passing CI. Raised to 81 after the contract tests below took the
    // score from 73 to 84: the gate now bites on the first rule that breaks
    // rather than the fifth.
    high: 90,
    low: 85,
    break: 81,
  },
  timeoutMS: 20000,
  concurrency: 4,
  // Generated output and test files are not inputs to the product.
  ignorePatterns: ["dist", "coverage", "reports", "test/fixtures/recorded"],
};
