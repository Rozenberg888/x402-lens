/**
 * Publish workspace packages to npm in dependency order.
 *
 *   npm run publish:npm
 *   npm run publish:npm -- --dry-run
 *
 * Requires `npm login` (or an automation token). Scoped packages are published
 * with `--access public` so the first release is world-readable.
 */

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

/** Publish order: dependents must see the dependency on the registry first. */
const PACKAGES = [
  { name: "@x402-lens/core", dir: "packages/core" },
  { name: "@x402-lens/express", dir: "packages/express" },
  { name: "x402-lens", dir: "packages/cli" },
];

/**
 * @param {string[]} args
 * @param {{ allowFail?: boolean }} [options]
 */
function npm(args, options = {}) {
  const result = spawnSync("npm", args, {
    cwd: ROOT,
    encoding: "utf8",
    shell: true,
    env: process.env,
  });
  if (!options.allowFail && result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`npm ${args.join(" ")} failed with exit ${String(result.status)}`);
  }
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const skipChecks = process.argv.includes("--skip-checks");
  const otpFlag = process.argv.findIndex(arg => arg === "--otp");
  const otp =
    otpFlag !== -1
      ? process.argv[otpFlag + 1]
      : process.env.NPM_OTP;

  const who = npm(["whoami"], { allowFail: true });
  if (who.status !== 0) {
    process.stderr.write(
      "Not logged in to npm.\n\n" +
        "  npm login\n\n" +
        "Then re-run: npm run publish:npm\n",
    );
    return 1;
  }
  process.stdout.write(`npm user: ${who.stdout.trim()}\n`);

  if (!skipChecks) {
    process.stdout.write("Running release checks once before publish…\n");
    const release = npm(["run", "release"], { allowFail: true });
    process.stdout.write(release.stdout);
    if (release.stderr) process.stderr.write(release.stderr);
    if (release.status !== 0) {
      process.stderr.write("Release checks failed. Fix them before publishing.\n");
      return release.status ?? 1;
    }
  } else {
    process.stdout.write("Skipping release checks (--skip-checks).\n");
  }

  for (const pkg of PACKAGES) {
    const manifest = JSON.parse(
      await readFile(join(ROOT, pkg.dir, "package.json"), "utf8"),
    );
    process.stdout.write(`\n→ ${pkg.name}@${manifest.version}${dryRun ? " (dry-run)" : ""}\n`);

    // Skip the package's own prepublishOnly: we already ran the full suite.
    const args = [
      "publish",
      "--workspace",
      pkg.name,
      "--access",
      "public",
      "--ignore-scripts",
    ];
    if (dryRun) args.push("--dry-run");
    if (otp) {
      args.push("--otp", otp);
    }

    const published = npm(args, { allowFail: true });
    process.stdout.write(published.stdout);
    if (published.stderr) process.stderr.write(published.stderr);
    if (published.status !== 0) {
      if ((published.stderr + published.stdout).includes("Two-factor authentication")) {
        process.stderr.write(
          "\nPublish requires 2FA. Enable it at https://www.npmjs.com/settings/~/security\n" +
            "then re-run with a fresh code:\n\n" +
            "  npm run publish:npm -- --skip-checks --otp 123456\n",
        );
      }
      process.stderr.write(`Failed to publish ${pkg.name}. Stopping.\n`);
      return published.status ?? 1;
    }

    if (!dryRun) {
      const viewed = npm(["view", pkg.name, "version"], { allowFail: true });
      if (viewed.status === 0) {
        process.stdout.write(`  registry: ${pkg.name}@${viewed.stdout.trim()}\n`);
      }
    }
  }

  process.stdout.write("\nAll packages published.\n");
  process.stdout.write("Next: git push origin v0.2.0\n");
  return 0;
}

process.exitCode = await main();
