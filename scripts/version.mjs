/**
 * Version every workspace package and its internal dependencies together.
 *
 * npm has no `workspace:*` protocol, so an internal dependency is a plain
 * version range that has to be kept equal to the package's own version by hand.
 * Forgetting produces the worst kind of release bug: `x402-lens@0.2.0` that
 * installs `@x402-lens/core@0.1.x` from the registry, so the CLI and the library
 * disagree about the wire format while both claim to work.
 *
 *   npm run version:set 0.2.0
 *   npm run version:set 0.2.0 -- --dry-run
 *
 * Only internal dependencies are rewritten. Third-party ranges (`^2.31.0`) are
 * left alone — this script is not a dependency updater.
 */

import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

/** Semantic version with an optional prerelease tag. */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Read and parse a JSON file.
 *
 * @param {string} path - Absolute path
 * @returns {Promise<any>} Parsed contents
 */
async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

/**
 * Write JSON with two-space indentation and a trailing newline, matching the
 * formatting the repo already uses so a version bump is a two-line diff.
 *
 * @param {string} path - Absolute path
 * @param {unknown} value - Value to serialise
 * @returns {Promise<void>}
 */
async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * Every package directory in the workspace, with its manifest.
 *
 * @returns {Promise<Array<{ dir: string; path: string; manifest: any }>>}
 */
async function workspacePackages() {
  const packagesDir = join(ROOT, "packages");
  const entries = await readdir(packagesDir, { withFileTypes: true });
  const found = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(packagesDir, entry.name, "package.json");
    try {
      found.push({ dir: join(packagesDir, entry.name), path, manifest: await readJson(path) });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
  }

  return found.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

/**
 * Set the version everywhere, keeping internal dependency ranges in step.
 *
 * @param {string} next - Target version
 * @param {{ dryRun: boolean }} options - Whether to report without writing
 * @returns {Promise<number>} Process exit code
 */
async function main(next, options) {
  if (!next) {
    process.stderr.write("Usage: npm run version:set <version>\n");
    return 2;
  }
  if (!SEMVER.test(next)) {
    process.stderr.write(
      `"${next}" is not a semantic version. Use one like 0.2.0 or 0.2.0-beta.1.\n`,
    );
    return 2;
  }

  const packages = await workspacePackages();
  if (packages.length === 0) {
    process.stderr.write("No workspace packages found under packages/.\n");
    return 1;
  }

  const byName = new Map(packages.map(entry => [entry.manifest.name, entry]));
  let changes = 0;

  for (const entry of packages) {
    const manifest = entry.manifest;
    const original = JSON.stringify(manifest);

    if (manifest.version !== next) {
      manifest.version = next;
    }

    for (const field of DEPENDENCY_FIELDS) {
      const deps = manifest[field];
      if (!deps) continue;
      for (const [name, range] of Object.entries(deps)) {
        // `@x402-lens/*` and any other local package name.
        if (!byName.has(name)) continue;
        if (range === next) continue;
        deps[name] = next;
        process.stdout.write(`  ${manifest.name}: ${field}.${name} ${range} → ${next}\n`);
        changes += 1;
      }
    }

    if (JSON.stringify(manifest) === original) continue;
    process.stdout.write(`${options.dryRun ? "would update" : "updated"} ${entry.manifest.name} → ${next}\n`);
    if (!options.dryRun) await writeJson(entry.path, manifest);
  }

  // Keep the root manifest's own version in step so the repo has one version.
  const rootPath = join(ROOT, "package.json");
  const root = await readJson(rootPath);
  if (root.version !== next) {
    root.version = next;
    process.stdout.write(`${options.dryRun ? "would update" : "updated"} root → ${next}\n`);
    if (!options.dryRun) await writeJson(rootPath, root);
  }

  if (changes === 0) {
    process.stdout.write("Internal dependency ranges already match.\n");
  }
  return 0;
}

const args = process.argv.slice(2).filter(arg => arg !== "--");
const dryRun = args.includes("--dry-run");
const version = args.find(arg => !arg.startsWith("--"));

process.exitCode = await main(version, { dryRun });
