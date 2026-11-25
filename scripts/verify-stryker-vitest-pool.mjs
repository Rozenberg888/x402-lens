/**
 * Smoke-test that Vitest finishes under Stryker's `pool: forks` settings on this OS.
 * Writes one NDJSON line to the debug log (no secrets).
 */
import { appendFileSync } from "node:fs";
import { createVitest } from "vitest/node";

const logPath = new URL("../.cursor/debug-60c56d.log", import.meta.url);
const sessionId = "60c56d";
const started = Date.now();

try {
  const ctx = await createVitest("test", {
    config: "vitest.config.ts",
    pool: "forks",
    poolOptions: { forks: { maxForks: 1, minForks: 1 } },
    maxConcurrency: 1,
    watch: false,
    coverage: { enabled: false },
    onConsoleLog: () => false,
  });
  await ctx.start();
  const fileCount = ctx.state.getFiles().length;
  appendFileSync(
    logPath,
    `${JSON.stringify({
      sessionId,
      runId: "stryker-pool-smoke",
      hypothesisId: "H3",
      location: "scripts/verify-stryker-vitest-pool.mjs",
      message: "vitest forks pool dry start completed",
      data: { pool: "forks", fileCount, elapsedMs: Date.now() - started },
      timestamp: Date.now(),
    })}\n`,
    "utf8",
  );
} catch (error) {
  appendFileSync(
    logPath,
    `${JSON.stringify({
      sessionId,
      runId: "stryker-pool-smoke",
      hypothesisId: "H3",
      location: "scripts/verify-stryker-vitest-pool.mjs",
      message: "vitest forks pool dry start failed",
      data: { pool: "forks", error: error instanceof Error ? error.message : String(error) },
      timestamp: Date.now(),
    })}\n`,
    "utf8",
  );
  process.exitCode = 1;
}