import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Tests run against package sources, not `dist`. A stale build must never be
 * able to mask a regression, and importing sources keeps coverage honest.
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
    include: ["packages/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["test/live/**"],
    environment: "node",
    testTimeout: 20_000,
    hookTimeout: 20_000,
    onConsoleLog(log, type) {
      // The SDK logs a decode failure to stderr. One test asserts that a
      // garbage PAYMENT-SIGNATURE ends in a 402 rather than a 500, so the
      // message is the expected behaviour, not noise worth printing.
      if (type === "stderr" && log.includes("Failed to decode PAYMENT-SIGNATURE")) {
        return false;
      }
      return undefined;
    },
  },
});
