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
    // Raise as gaps close. A threshold below the current score silently allows
    // regressions, so this is a floor, not a goal.
    high: 90,
    low: 80,
    break: 70,
  },
  timeoutMS: 20000,
  concurrency: 4,
  // Generated output and test files are not inputs to the product.
  ignorePatterns: ["dist", "coverage", "reports", "test/fixtures/recorded"],
};
