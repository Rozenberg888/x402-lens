/**
 * Refuse to publish a package whose internal dependencies disagree with it, or
 * whose internal dependencies are not on the registry at all.
 *
 * Two distinct failures, both invisible until a consumer installs the package:
 *
 * 1. Version drift. npm has no `workspace:` protocol, so
 *    `@x402-lens/express` depends on `@x402-lens/core` by a literal range. A
 *    stale range installs an older core from the registry: a release that looks
 *    fine locally and disagrees about the wire format in production.
 * 2. A dependency that was never published. `@x402-lens/express` depends on
 *    `@x402-lens/server`; if that name is absent from the registry, publishing
 *    express *succeeds* and every install of it fails with `404 Not Found`.
 *    That is worse than not publishing: the version exists, cannot be used, and
 *    `npm unpublish` is discouraged.
 *
 * Runs as `prepublishOnly`, so `npm publish` fails here rather than shipping.
 */

import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { runNpm } from "./npm-runner.mjs";

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

/**
 * Fields whose dependencies a consumer actually installs.
 *
 * `devDependencies` are excluded from the registry check on purpose: they are
 * not installed when someone adds this package to their project, so a missing
 * dev dependency cannot break an install. They are still checked for version
 * drift, because a stale dev range breaks the maintainer's own test run.
 */
const INSTALLED_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"];

/**
 * Names of every package in the workspace, so "internal" needs no hard-coded
 * list that could drift.
 *
 * @returns {Promise<Set<string>>}
 */
async function workspaceNames() {
  const { readdir } = await import("node:fs/promises");
  const packagesDir = resolve(import.meta.dirname, "..", "packages");
  const names = new Set();

  for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const manifest = JSON.parse(
        await readFile(join(packagesDir, entry.name, "package.json"), "utf8"),
      );
      if (typeof manifest.name === "string") names.add(manifest.name);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
  }

  return names;
}

/**
 * Ask the registry whether one exact version of a package exists.
 *
 * `npm view` rather than a direct HTTP call so a user's configured registry
 * (`.npmrc`, a corporate mirror) is respected — the whole point is to check the
 * registry this publish will write to.
 *
 * @param {string} name - Package name, e.g. `@x402-lens/server`
 * @param {string} version - Exact version to look for
 * @returns {Promise<"present" | "missing" | "unknown">} `unknown` means the
 *   registry could not be reached, which is a different situation from `missing`
 */
async function registryState(name, version) {
  try {
    await runNpm(["view", `${name}@${version}`, "version"], { timeout: 15_000 });
    return "present";
  } catch (error) {
    // `npm view` exits non-zero both for "no matching version" and for genuine
    // failures (network, auth, a missing npm). Treating them the same would
    // either block every offline publish or hide the case this check exists for,
    // so the output is what distinguishes them.
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    if (/E404|404 Not Found|is not in this registry|No match found/i.test(output)) {
      return "missing";
    }
    return "unknown";
  }
}

const manifestPath = resolve(process.cwd(), "package.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const internal = await workspaceNames();

const problems = [];

if (manifest.private === true) {
  // A private package is not meant to be published at all; nothing to verify.
  process.exit(0);
}

/** Internal dependencies whose registry presence has to be checked. */
const toVerify = [];

for (const field of DEPENDENCY_FIELDS) {
  for (const [name, range] of Object.entries(manifest[field] ?? {})) {
    if (!internal.has(name)) continue;
    if (range !== manifest.version) {
      problems.push(
        `  ${field}.${name} is "${range}" but ${manifest.name} is ${manifest.version}`,
      );
    }
    if (INSTALLED_FIELDS.includes(field)) toVerify.push({ field, name, range });
  }
}

// Skip with SKIP_REGISTRY_CHECK=1 when publishing offline or rehearsing. It is
// an explicit opt-out rather than a silent fallback: a fallback would defeat the
// check in exactly the environment where it matters.
if (process.env.SKIP_REGISTRY_CHECK !== "1") {
  const states = await Promise.all(
    toVerify.map(async entry => ({ ...entry, state: await registryState(entry.name, entry.range) })),
  );

  for (const { field, name, range, state } of states) {
    if (state === "missing") {
      problems.push(
        `  ${field}.${name}@${range} is not on the registry. Publishing now would make this package impossible to install: consumers get "404 Not Found" for ${name}. Publish ${name}@${range} first, then this package.`,
      );
    }
    if (state === "unknown") {
      // Not a failure: an offline publish would fail anyway, and blocking here
      // would make a rehearsed release impossible without network. Saying it out
      // loud is the compromise.
      process.stderr.write(
        `Warning: could not confirm ${name}@${range} exists on the registry (network). ` +
          `Set SKIP_REGISTRY_CHECK=1 to silence this, or verify the order of publishing manually.\n`,
      );
    }
  }
}

if (problems.length > 0) {
  process.stderr.write(
    `Refusing to publish ${basename(process.cwd())}:\n` +
      `${problems.join("\n")}\n\n` +
      "Internal dependency versions must match, and every internal dependency must already be\n" +
      "published at that version. Run `npm run version:set <version>` to move them together,\n" +
      "and publish in dependency order: core → server → express/hono/mcp → cli.\n",
  );
  process.exit(1);
}

process.exit(0);
