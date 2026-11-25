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

import { findNpmCli } from "./npm-runner.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const NPM_CLI = await findNpmCli();

if (!NPM_CLI) {
  process.stderr.write("could not locate npm-cli.js in any known location\n");
  process.exit(1);
}

/**
 * Accept `--otp 123456`, `--otp=123456`, or env `NPM_OTP` (npm run … -- forwards argv).
 * CLI wins over env so a stale `NPM_OTP` in the shell does not override a fresh `--otp`.
 * @param {string[]} argv
 * @returns {{ code: string; source: "argv" | "env" } | undefined}
 */
function parseOtp(argv) {
  const eq = argv.find((arg) => arg.startsWith("--otp="));
  if (eq) {
    const value = eq.slice("--otp=".length).trim();
    if (value.length > 0) {
      return { code: value, source: "argv" };
    }
  }
  const idx = argv.findIndex((arg) => arg === "--otp");
  if (idx !== -1) {
    const next = argv[idx + 1];
    if (next && !next.startsWith("-")) {
      return { code: next.trim(), source: "argv" };
    }
  }
  const fromEnv = process.env.NPM_OTP?.trim();
  if (fromEnv) {
    return { code: fromEnv, source: "env" };
  }
  return undefined;
}

/** Publish order: dependents must see the dependency on the registry first. */
const PACKAGES = [
  { name: "@x402-lens/core", dir: "packages/core" },
  // Express depends on server at install time; publishing express without server
  // ships a version every consumer installs as 404.
  { name: "@x402-lens/server", dir: "packages/server" },
  { name: "@x402-lens/express", dir: "packages/express" },
  { name: "@x402-lens/cli", dir: "packages/cli" },
];

/**
 * @param {string[]} args
 * @param {{ allowFail?: boolean }} [options]
 */
function npm(args, options = {}) {
  // Run npm's CLI through the current Node binary: on Windows `npm` is a .cmd
  // shim, and both `execFile("npm", …)` (ENOENT) and `shell: true` (quoting) are
  // worse. See scripts/npm-runner.mjs for the full rationale.
  const result = spawnSync(process.execPath, [NPM_CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    env: process.env,
  });
  const exit = result.status ?? 1;
  if (!options.allowFail && exit !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`npm ${args.join(" ")} failed with exit ${String(exit)}`);
  }
  return {
    status: exit,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/**
 * Run npm with the terminal attached so npm can drive its browser-based 2FA
 * (security key / passkey) flow. Used when no TOTP code is supplied: with piped
 * stdio npm cannot prompt, and the publish fails with a bare EOTP instead.
 * @param {string[]} args
 * @returns {number}
 */
function npmInteractive(args) {
  const result = spawnSync(process.execPath, [NPM_CLI, ...args], {
    cwd: ROOT,
    stdio: "inherit",
    windowsHide: true,
    env: process.env,
  });
  return result.status ?? 1;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const skipChecks = process.argv.includes("--skip-checks");
  const otpParsed = parseOtp(process.argv);
  const otp = otpParsed?.code;

  const who = npm(["whoami"], { allowFail: true });
  const whoUser = who.stdout.trim();
  if (who.status !== 0 || !whoUser) {
    if (who.stderr) process.stderr.write(who.stderr);
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

  if (otpParsed) {
    const where =
      otpParsed.source === "argv"
        ? "command line (--otp)"
        : "NPM_OTP env var (clear if stale: Remove-Item Env:NPM_OTP)";
    process.stdout.write(`2FA: using OTP from ${where}.\n`);
    process.stdout.write(
      "NOTE: --otp only works with an authenticator app (TOTP) on npm.\n" +
        "      If npm only has a security key, drop --otp and use the browser flow:\n" +
        "        npm run publish:npm -- --skip-checks\n",
    );
  } else if (!dryRun) {
    process.stdout.write(
      "No --otp / NPM_OTP set — each package opens npm's browser 2FA flow.\n" +
        "Approve it with your security key / passkey, then npm continues automatically.\n",
    );
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
      args.push(`--otp=${otp}`);
    }

    // Without an OTP npm must be able to talk to the terminal to run the
    // security-key handshake; piping stdio makes it fail with a bare EOTP.
    const published =
      otp || dryRun
        ? npm(args, { allowFail: true })
        : { status: npmInteractive(args), stdout: "", stderr: "" };
    process.stdout.write(published.stdout);
    if (published.stderr) process.stderr.write(published.stderr);
    if (published.status !== 0) {
      const out = published.stderr + published.stdout;
      if (out.includes("EOTP") || out.includes("Two-factor authentication")) {
        process.stderr.write(
          "\nPublish requires 2FA (auth-and-writes). The registry rejected the OTP.\n" +
            "  npm whoami --otp=… does NOT prove the code works for publish — skip it.\n\n" +
            "Try one of:\n" +
            "  A) Fresh TOTP only on publish (new code, <15s):\n" +
            "       npm run publish:npm -- --skip-checks --otp=XXXXXX\n" +
            "  B) Session login (remove granular _authToken from ~/.npmrc, then npm login),\n" +
            "     then publish with --otp=…\n" +
            "  C) Granular token: Packages read+write + automation (or browser URL / security key\n" +
            "     if publish runs without --otp)\n" +
            "  D) Confirm Authentication app is on https://www.npmjs.com/settings/~/security\n\n",
        );
        if (otpParsed?.source === "env") {
          process.stderr.write(
            "Hint: OTP came from NPM_OTP — it may be expired. Remove-Item Env:NPM_OTP, then use a fresh --otp=CODE.\n",
          );
        } else if (!otp) {
          process.stderr.write(
            "Hint: pass --otp=CODE on this command, not only on npm whoami.\n",
          );
        }
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
  process.stdout.write("Next: git tag v0.2.5 && git push origin v0.2.5\n");
  return 0;
}

process.exitCode = await main();
