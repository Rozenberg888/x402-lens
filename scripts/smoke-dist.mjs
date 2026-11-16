/**
 * Load the built packages the way a consumer would.
 *
 * The test suite imports TypeScript sources through a Vitest alias, so it never
 * touches `dist`. That means a build that produces nothing, or a CommonJS entry
 * that cannot be `require`d, would pass every test and fail every user — this is
 * the only check that exercises what actually ships.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const failures = [];

/**
 * Assert a module exposes the exports a consumer relies on.
 *
 * @param {string} label - How to name this entry point in output
 * @param {() => unknown} load - Loads the module
 * @param {string[]} expected - Export names that must be present
 */
function check(label, load, expected) {
  let module;
  try {
    module = load();
  } catch (error) {
    failures.push(`${label}: failed to load — ${error.message}`);
    return;
  }

  for (const name of expected) {
    if (module[name] === undefined) {
      failures.push(`${label}: missing export "${name}"`);
    }
  }
  process.stdout.write(`ok   ${label}\n`);
}

check(
  "@x402-lens/core (cjs)",
  () => require("../packages/core/dist/index.cjs"),
  ["resolveConfig", "toRoutesConfig", "diagnose", "EventBus", "validatePaymentRequired"],
);

check(
  "@x402-lens/express (cjs)",
  () => require("../packages/express/dist/index.cjs"),
  ["paymentLens", "paymentLensAsync"],
);

// ESM is what the packages declare first in `exports`, so both paths matter.
const coreEsm = await import("../packages/core/dist/index.js");
check("@x402-lens/core (esm)", () => coreEsm, ["resolveConfig", "toRoutesConfig", "diagnose"]);

const expressEsm = await import("../packages/express/dist/index.js");
check("@x402-lens/express (esm)", () => expressEsm, ["paymentLens"]);

if (failures.length > 0) {
  process.stderr.write(`\nBuilt entry points are not usable:\n${failures.map(line => `  ${line}`).join("\n")}\n`);
  process.exit(1);
}

process.stdout.write("\nAll built entry points load and expose their public API.\n");
