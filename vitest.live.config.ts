import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Live tests reach the public facilitator, so they are a separate run.
 *
 * Same source aliases as `vitest.config.ts`: package `exports` point at
 * `dist/`, which is absent after a bare `npm ci` in CI.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@x402-lens/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@x402-lens/express": fileURLToPath(
        new URL("./packages/express/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["test/live/**/*.live.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
