/**
 * The publish guard, tested by running it.
 *
 * `check-workspace-versions.mjs` runs as `prepublishOnly`, which is the one place
 * a mistake costs the most: it decides whether a package that cannot be installed
 * reaches the registry. It also just grew a second job — confirming internal
 * dependencies exist on npm — and the first version of that job failed silently
 * on every Windows machine, reporting "could not confirm" for packages that were
 * present, because `execFile("npm", …)` cannot spawn a `.cmd` shim.
 *
 * So this drives the real script as a subprocess against a temporary workspace,
 * rather than importing its internals. The failure above was in how the script
 * talks to npm, which no unit test on its own functions would have caught.
 */

import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Build a throwaway workspace with one package and run the guard against it.
 *
 * The script resolves its siblings by walking `packages/` from its own location,
 * so the copy has to reproduce that layout for "internal" to mean anything. A
 * dependency that is not in `packages/` is treated as external and skipped — the
 * guard only governs what this repository publishes — so the "missing" case has
 * to add the package to the workspace without publishing it.
 */
async function runGuard(options: {
  packageName: string;
  version: string;
  dependencies: Record<string, string>;
  /** Extra workspace packages, as name → version, that are NOT on npm. */
  unpublishedSiblings?: Record<string, string>;
  privatePackage?: boolean;
  env?: Record<string, string>;
}): Promise<RunResult> {
  const workspace = await mkdtemp(join(tmpdir(), "guard-"));
  await mkdir(join(workspace, "scripts"), { recursive: true });
  await mkdir(join(workspace, "packages", "subject"), { recursive: true });
  // A sibling that exists in the registry, so a "present" case is possible.
  await mkdir(join(workspace, "packages", "known"), { recursive: true });

  await cp(
    join(ROOT, "scripts", "check-workspace-versions.mjs"),
    join(workspace, "scripts", "check-workspace-versions.mjs"),
  );
  await cp(join(ROOT, "scripts", "npm-runner.mjs"), join(workspace, "scripts", "npm-runner.mjs"));

  await writeFile(
    join(workspace, "packages", "known", "package.json"),
    JSON.stringify({ name: "@x402-lens/core", version: "0.2.4" }),
    "utf8",
  );

  for (const [name, version] of Object.entries(options.unpublishedSiblings ?? {})) {
    const dir = name.replace(/^@[^/]+\//, "");
    await mkdir(join(workspace, "packages", dir), { recursive: true });
    await writeFile(
      join(workspace, "packages", dir, "package.json"),
      JSON.stringify({ name, version }),
      "utf8",
    );
  }

  await writeFile(
    join(workspace, "packages", "subject", "package.json"),
    JSON.stringify({
      name: options.packageName,
      version: options.version,
      ...(options.privatePackage ? { private: true } : {}),
      dependencies: options.dependencies,
    }),
    "utf8",
  );

  try {
    const result = await run(
      process.execPath,
      [join(workspace, "scripts", "check-workspace-versions.mjs")],
      {
        cwd: join(workspace, "packages", "subject"),
        env: { ...process.env, ...options.env },
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

describe("publish guard: version drift", () => {
  it("refuses when an internal dependency has a different version", async () => {
    const result = await runGuard({
      packageName: "@x402-lens/express",
      version: "0.2.5",
      dependencies: { "@x402-lens/core": "0.2.4" },
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("is \"0.2.4\" but @x402-lens/express is 0.2.5");
  });

  it("passes when the versions agree and the dependency is published", async () => {
    // `@x402-lens/core@0.2.4` is on npm, so this exercises the happy path end to
    // end: range matches, registry confirms.
    const result = await runGuard({
      packageName: "@x402-lens/express",
      version: "0.2.4",
      dependencies: { "@x402-lens/core": "0.2.4" },
    });

    expect(result.stderr).not.toContain("Refusing to publish");
    expect(result.code).toBe(0);
  });
});

describe("publish guard: dependency missing from the registry", () => {
  it("refuses to publish a package whose dependency does not exist", async () => {
    // This is the concrete defect: express depends on server, server is a
    // workspace package that was never published, and publishing express would
    // produce a version nobody can install — `404 Not Found` on every
    // `npm install`.
    const result = await runGuard({
      packageName: "@x402-lens/express",
      version: "0.2.4",
      dependencies: { "@x402-lens/ghost-unpublished": "0.2.4" },
      unpublishedSiblings: { "@x402-lens/ghost-unpublished": "0.2.4" },
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("is not on the registry");
  });

  it("names the missing package and the 404 the consumer would see", async () => {
    const result = await runGuard({
      packageName: "@x402-lens/express",
      version: "0.2.4",
      dependencies: { "@x402-lens/ghost-unpublished": "0.2.4" },
      unpublishedSiblings: { "@x402-lens/ghost-unpublished": "0.2.4" },
    });

    // The reader needs the package name and the consequence, which is what makes
    // this message useful rather than a bare failure.
    expect(result.stderr).toContain("@x402-lens/ghost-unpublished");
    expect(result.stderr).toContain("404");
  });

  it("ignores a missing dependency when the check is explicitly skipped", async () => {
    // Publishing offline or rehearsing needs a way out; it is an explicit flag
    // rather than a silent fallback, because a fallback would defeat the check in
    // exactly the environment where it matters.
    const result = await runGuard({
      packageName: "@x402-lens/express",
      version: "0.2.4",
      dependencies: { "@x402-lens/ghost-unpublished": "0.2.4" },
      unpublishedSiblings: { "@x402-lens/ghost-unpublished": "0.2.4" },
      env: { SKIP_REGISTRY_CHECK: "1" },
    });

    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain("is not on the registry");
  });

  it("ignores a dependency that is not part of this workspace", async () => {
    // An external package is not this repository's to publish, so its absence
    // says nothing about whether the release is safe. Checking it would make the
    // guard refuse for a reason the maintainer cannot fix.
    const result = await runGuard({
      packageName: "@x402-lens/express",
      version: "0.2.4",
      dependencies: { "some-external-package": "1.0.0" },
    });

    expect(result.code).toBe(0);
  });
});

describe("publish guard: private packages", () => {
  it("exits immediately for a private package", async () => {
    // The workspace root is private and is never published, so it must not be
    // held to publish rules.
    const result = await runGuard({
      packageName: "x402-lens-monorepo",
      version: "0.2.4",
      dependencies: { "@x402-lens/ghost-unpublished": "0.2.4" },
      unpublishedSiblings: { "@x402-lens/ghost-unpublished": "0.2.4" },
      privatePackage: true,
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
  });
});

describe("npm-runner", () => {
  it("locates npm and runs a real command", async () => {
    // The first version of the guard used `execFile("npm", …)`, which fails with
    // ENOENT on Windows because `npm` there is a `.cmd` shim. This asserts the
    // shared runner actually works, which is what that bug would have broken.
    //
    // The import is untyped on purpose: the script is plain `.mjs` and the repo
    // does not enable `allowJs`, so enabling it project-wide for two test
    // imports would be the wrong trade. The behaviour below is the assertion.
    // @ts-expect-error - plain .mjs script, no declaration file
    const { runNpm } = await import("../scripts/npm-runner.mjs");
    const { stdout } = await runNpm(["view", "@x402-lens/core@0.2.4", "version"]);
    expect(stdout.trim()).toBe("0.2.4");
  }, 30_000);

  it("reports a missing version distinguishably from a network failure", async () => {
    // @ts-expect-error - plain .mjs script, no declaration file
    const { runNpm } = await import("../scripts/npm-runner.mjs");
    await expect(
      runNpm(["view", "@x402-lens/core@999.999.999", "version"], { timeout: 20_000 }),
    ).rejects.toThrow(/E404|404|No match/i);
  }, 30_000);
});
