import { defineConfig } from "vitest/config";

/**
 * Live tests reach the public facilitator, so they are a separate run.
 */
export default defineConfig({
  test: {
    include: ["test/live/**/*.live.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
