/**
 * Run npm commands from a script without depending on the shell.
 *
 * `npm` on Windows is a `.cmd` shim, and `execFile("npm", …)` fails with ENOENT
 * because a `.cmd` is not an executable image. Shelling out instead would mean
 * quoting every argument, which is its own class of bug.
 *
 * The way out is to run npm's JavaScript entry point with the current Node
 * binary. Its location differs by installation: Windows bundles npm under the
 * Node directory, while Linux (including the `/opt/hostedtoolcache` layout on
 * GitHub runners) installs it separately. So it is discovered, not assumed.
 *
 * Extracted because two scripts need it now and a third will: the copy in
 * check-package-contents.mjs was the only one that knew about this, and
 * check-workspace-versions.mjs shipped with a plain `execFile("npm", …)` that
 * silently failed on every Windows machine — reporting "could not confirm" for
 * packages that were present.
 */

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

let cached;

/**
 * Absolute path to npm's CLI entry point.
 *
 * @returns {Promise<string | undefined>} Path, or undefined when npm cannot be found
 */
export async function findNpmCli() {
  if (cached !== undefined) return cached;

  const candidates = [
    resolve(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    resolve(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
    "/usr/lib/node_modules/npm/bin/npm-cli.js",
  ];

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.R_OK);
      cached = candidate;
      return cached;
    } catch {
      // Try the next location.
    }
  }

  // Last resort: ask npm where it is, which works wherever it is on PATH.
  // `npm root -g` also goes through the .cmd shim, so this only helps when the
  // shim itself is spawnable — on Windows it is not, which is why the explicit
  // candidates above come first.
  for (const shell of [false, true]) {
    try {
      const { stdout } = shell
        ? await run("npm", ["root", "-g"], { shell: true })
        : await run("npm", ["root", "-g"]);
      const candidate = resolve(stdout.trim(), "npm", "bin", "npm-cli.js");
      await access(candidate, constants.R_OK);
      cached = candidate;
      return cached;
    } catch {
      // Try the next strategy.
    }
  }

  cached = undefined;
  return undefined;
}

/**
 * Run `npm <args>` and capture stdout.
 *
 * @param {string[]} args - Arguments after `npm`
 * @param {{ cwd?: string, timeout?: number }} [options] - Working directory and timeout
 * @returns {Promise<{ stdout: string, stderr: string }>}
 * @throws When npm cannot be located, or the command exits non-zero
 */
export async function runNpm(args, options = {}) {
  const cli = await findNpmCli();
  if (!cli) {
    throw new Error("could not locate npm-cli.js in any known location");
  }
  return await run(process.execPath, [cli, ...args], {
    cwd: options.cwd,
    timeout: options.timeout,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });
}
