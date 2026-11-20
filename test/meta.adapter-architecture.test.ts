/**
 * Guards for the adapter architecture.
 *
 * A behaviour test cannot catch the defect these exist for. Twice now an
 * adapter was shipped that kept its own copy of the shared payment path while
 * the commit message claimed otherwise — and both times the whole suite stayed
 * green, because a copy behaves identically until someone fixes a bug in one of
 * them.
 *
 * So these read the source and assert the wiring. It is a blunter kind of test
 * than the rest, and it is the only kind that fails when the duplication is
 * reintroduced.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

function source(packageName: string): string {
  return readFileSync(resolve(root, `packages/${packageName}/src/index.ts`), "utf8");
}

/**
 * Functions that belong to the shared layer.
 *
 * Each of these was duplicated verbatim in the Express adapter once already.
 * If an adapter defines one again, the payment path has forked.
 */
const SHARED_FUNCTIONS = [
  "attachHooks",
  "registerScheme",
  "schemesInUse",
  "buildSinks",
  "buildFacilitatorClient",
  "buildCorsHeaders",
  "matchRouteConfig",
  "pathMatchesPattern",
  "safeCall",
  "baseEvent",
  "syntheticChallenge",
];

describe("adapter architecture", () => {
  for (const adapter of ["express", "hono"]) {
    it(`${adapter} imports the shared payment path instead of defining it`, () => {
      const src = source(adapter);
      expect(src).toContain('from "@x402-lens/server"');

      for (const name of SHARED_FUNCTIONS) {
        // A definition, not a call: `function name(` or `const name =`.
        const defines = new RegExp(`(^|\\n)\\s*(export\\s+)?(function|const)\\s+${name}\\b`);
        expect(
          defines.test(src),
          `packages/${adapter}/src/index.ts defines ${name}, which belongs to @x402-lens/server. ` +
            `Import it instead — a second copy is how the two adapters drift apart.`,
        ).toBe(false);
      }
    });

    it(`${adapter} declares @x402-lens/server as a dependency`, () => {
      const manifest = JSON.parse(
        readFileSync(resolve(root, `packages/${adapter}/package.json`), "utf8"),
      ) as { dependencies?: Record<string, string> };
      // Importing without declaring works in the workspace and fails for a user
      // after publish, so the manifest has to agree with the import.
      expect(manifest.dependencies?.["@x402-lens/server"]).toBeTruthy();
    });
  }

  it("shared layer imports no framework", () => {
    const src = source("server");
    for (const framework of ["express", "hono"]) {
      expect(src).not.toMatch(new RegExp(`from\\s+["']${framework}["']`));
    }
  });
});
