/**
 * Refuse to publish a package whose internal dependencies disagree with it.
 *
 * npm has no `workspace:` protocol, so `@x402-lens/express` depends on
 * `@x402-lens/core` by a literal range. If the range is stale, the published
 * package installs an older core from the registry: a release that looks fine
 * locally and disagrees about the wire format in production.
 *
 * Runs as `prepublishOnly`, so `npm publish` fails here rather than shipping.
 */

import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

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

const manifestPath = resolve(process.cwd(), "package.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const internal = await workspaceNames();

const problems = [];

if (manifest.private === true) {
  // A private package is not meant to be published at all; nothing to verify.
  process.exit(0);
}

for (const field of DEPENDENCY_FIELDS) {
  for (const [name, range] of Object.entries(manifest[field] ?? {})) {
    if (!internal.has(name)) continue;
    if (range === manifest.version) continue;
    problems.push(
      `  ${field}.${name} is "${range}" but ${manifest.name} is ${manifest.version}`,
    );
  }
}

if (problems.length > 0) {
  process.stderr.write(
    `Refusing to publish ${basename(process.cwd())}: internal dependency versions must match.\n` +
      `${problems.join("\n")}\n\n` +
      "Run `npm run version:set <version>` so the packages and their ranges move together.\n",
  );
  process.exit(1);
}

process.exit(0);
