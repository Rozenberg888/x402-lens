import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.js";

/**
 * Stryker sandboxes the repo and runs the full suite. The publish-guard tests
 * spawn real `npm` against the registry and flake under parallel workers — they
 * are release gates, not mutation inputs.
 */
export default mergeConfig(
  base,
  defineConfig({
    test: {
      exclude: [
        ...(Array.isArray(base.test?.exclude) ? base.test.exclude : []),
        "test/scripts.publish-guard.test.ts",
      ],
    },
  }),
);