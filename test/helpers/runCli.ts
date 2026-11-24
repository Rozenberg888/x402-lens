/**
 * Running the real CLI in a child process, from source.
 *
 * Some CLI behaviour only exists at the process boundary: exit codes, what lands
 * on stderr versus stdout, and whether `--json` holds on an error path. Calling
 * `main()` in-process cannot test any of it.
 *
 * The CLI is run from **source**, not from `packages/cli/dist`. Three test files
 * used to spawn the built `dist/index.js`, which is gitignored and absent on a
 * fresh clone — so `npm test` was red for anyone who had not run `npm run build`
 * first, and CI runs `npm test` before `npm run build`. It also made the suite
 * untestable under mutation testing, which copies the tree into a sandbox where
 * no `dist` has been built: the dry run failed on a stale binary before a single
 * mutant was reached.
 *
 * `node --import tsx` resolves the TypeScript entry and the workspace packages,
 * which is the same resolution the tests use.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");

/** The CLI entry point, in source form. */
export const CLI_SOURCE = join(ROOT, "packages", "cli", "src", "index.ts");

export interface CliRun {
  /** Process exit code. A killed process reports 1. */
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn the CLI without waiting for it.
 *
 * For the tests that must signal the process — SIGINT handling is only testable
 * on a live child, since the point is what happens *while* it runs.
 *
 * @param args - Arguments after the script name
 * @param options - Working directory
 * @returns The child process
 */
export function spawnCli(
  args: string[],
  options: { cwd?: string } = {},
): ChildProcessWithoutNullStreams {
  // `stdio` omitted: the default gives all three pipes, which is exactly the
  // non-null stream shape the caller reads.
  return spawn(process.execPath, ["--import", "tsx", CLI_SOURCE, ...args], {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, NO_COLOR: "1" },
  });
}

/**
 * Run the CLI and capture everything.
 *
 * @param args - Arguments after the script name
 * @param options - Working directory and kill timeout
 * @returns Exit code and both streams
 */
export function runCli(
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<CliRun> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  return new Promise(resolvePromise => {
    const child = spawnCli(args, options);

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => (stdout += String(chunk)));
    child.stderr.on("data", chunk => (stderr += String(chunk)));

    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("close", code => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}
