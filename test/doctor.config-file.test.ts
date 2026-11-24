/**
 * `doctor` must not let an override paper over a broken config file.
 *
 * The two `loadConfig` failures look alike from the outside and need opposite
 * handling:
 *
 *   no configuration at all  → the overrides exist for exactly this, so probe
 *   a config file that is broken → the deploy is broken; overrides hide it
 *
 * `doctor` treated both the same, so `--facilitator` turned
 * `config: FAIL x402.config.json is not valid JSON` into
 * `config: ok (probed with overrides)` and the command ended in
 * "All checks passed". The gate flipped from fail to pass by adding a flag
 * unrelated to the broken file — and the server would then fail at startup on
 * the same file.
 *
 * The distinction is read from `ConfigError.field`, so these tests also pin that
 * the file reader keeps attributing parse failures to the file name.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_FILE_FIELD, ConfigError, loadConfig } from "@x402-lens/core";
import { runDoctor } from "../packages/cli/src/commands/doctor.js";

const dirs: string[] = [];

/** A temp directory, removed after the test. */
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lens-doctor-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("loadConfig: the file field is the structural signal", () => {
  it("attributes a parse failure to the config file", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "x402.config.json"), '{"facilitatorUrl": ', "utf8");

    const error = await loadConfig({ readConfigFile: true, cwd: dir, env: {} }).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).field).toBe(CONFIG_FILE_FIELD);
  });

  it("does not attribute a missing value to the config file", async () => {
    // The distinction doctor depends on: absent configuration is answerable by
    // overrides, so it must not look like a broken file.
    const dir = await tempDir();

    const error = await loadConfig({ readConfigFile: true, cwd: dir, env: {} }).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).field).not.toBe(CONFIG_FILE_FIELD);
  });
});

describe("doctor: a broken config file stays a failure", () => {
  it("fails even when facilitator and network overrides are supplied", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "x402.config.json"), '{"facilitatorUrl": ', "utf8");

    const result = await runDoctor({
      cwd: dir,
      facilitatorUrl: "https://facilitator.example.com",
      network: "eip155:84532",
    });

    expect(result.exitCode).not.toBe(0);
    const config = result.checks.find(check => check.name === "config");
    expect(config?.ok).toBe(false);
    expect(config?.detail).toMatch(/not valid JSON/);
    // The message has to say why the override does not help, or the operator
    // reads "FAIL config" next to a supplied --facilitator and concludes the tool
    // is confused.
    expect(config?.detail).toMatch(/Overrides cannot stand in/);
  });

  it("reports which file, not just that something failed", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "x402.config.json"), "{]", "utf8");

    const result = await runDoctor({
      cwd: dir,
      facilitatorUrl: "https://facilitator.example.com",
      network: "eip155:84532",
    });

    const config = result.checks.find(check => check.name === "config");
    expect(config?.detail).toContain(CONFIG_FILE_FIELD);
  });

  it("still probes with overrides when there is simply no configuration", async () => {
    // The behaviour that must survive: `doctor` is documented as usable in a
    // fresh directory with --facilitator and --network, and it is the first thing
    // an operator runs before writing any config.
    const dir = await tempDir();

    const result = await runDoctor({
      cwd: dir,
      facilitatorUrl: "https://facilitator.invalid",
      network: "eip155:84532",
      timeoutMs: 250,
    });

    const config = result.checks.find(check => check.name === "config");
    // The probe itself will fail against an unreachable host; what matters is
    // that the config check did not treat "absent" as "broken".
    expect(config?.detail).toMatch(/No configuration was found/);
    expect(config?.detail).not.toMatch(/Overrides cannot stand in/);
  });
});
