/**
 * Check what `npm pack` would actually publish.
 *
 * Publishing is close to irreversible: `npm unpublish` is discouraged and leaves
 * a trace. A manifest that forgets `dist` in `files`, or that ships sources and
 * test fixtures, is much cheaper to catch here than after the upload.
 *
 *   npm run build && node scripts/check-package-contents.mjs
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");

/**
 * Path to npm's CLI entry point.
 *
 * `npm` on Windows is a `.cmd` shim, which `execFile` cannot spawn directly
 * (`ENOENT`), and shelling out would mean quoting every argument. Running the
 * JavaScript entry point with the current Node binary works on every platform
 * and keeps the argument list out of a shell.
 */
const NPM_CLI = resolve(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");

/**
 * Run `npm pack --dry-run --json` in a directory.
 *
 * @param {string} cwd - Package directory
 * @returns {Promise<object>} Parsed pack metadata
 */
async function packInfo(cwd) {
  const { stdout } = await run(process.execPath, [NPM_CLI, "pack", "--dry-run", "--json"], {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  const [info] = JSON.parse(stdout);
  return info;
}

/**
 * Files that must be in the tarball for the package to be usable.
 *
 * A CLI is consumed as an executable, not imported, so it needs no type
 * declarations — requiring them there would be a false alarm.
 */
function requiredFiles(manifest) {
  const common = ["package.json", "README.md", "dist/index.js"];
  if (manifest.bin) return common;
  return [...common, "dist/index.cjs", "dist/index.d.ts"];
}

/**
 * Paths that must never ship.
 *
 * Source maps are deliberately allowed: `tsup` inlines sources, so they let a
 * user step through a failed payment without cloning the repo — which is the
 * point of the product. What must not ship is raw source trees, tests, and build
 * configuration, which only exist for maintainers.
 */
const FORBIDDEN = [/^src\//, /^test\//, /^tsconfig/, /^tsup\.config/];

const packages = ["core", "express", "cli"];
const problems = [];

for (const name of packages) {
  const dir = join(ROOT, "packages", name);
  const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));

  if (manifest.private === true) {
    process.stdout.write(`skip ${manifest.name} (private)\n`);
    continue;
  }

  // `--dry-run` reports the tarball name and file list without leaving a file
  // behind, so this is safe to run on every CI job.
  let info;
  try {
    info = await packInfo(dir);
  } catch (error) {
    problems.push(`${manifest.name}: npm pack failed — ${error.message}`);
    continue;
  }

  const files = (info.files ?? []).map(entry => entry.path);
  const fileSet = new Set(files);

  for (const required of requiredFiles(manifest)) {
    if (!fileSet.has(required)) {
      problems.push(`${manifest.name}: missing ${required} — users cannot import it`);
    }
  }

  for (const file of files) {
    const offending = FORBIDDEN.find(pattern => pattern.test(file));
    if (offending) {
      problems.push(`${manifest.name}: ships ${file}, which should not be published`);
    }
  }

  process.stdout.write(`ok   ${manifest.name} (${files.length} files, ${Math.round((info.size ?? 0) / 1024)} KB)\n`);
}

if (problems.length > 0) {
  process.stderr.write(`\nPackaging problems:\n${problems.map(line => `  ${line}`).join("\n")}\n`);
  process.exit(1);
}

process.stdout.write("\nAll package tarballs contain what they need and nothing they should not.\n");
