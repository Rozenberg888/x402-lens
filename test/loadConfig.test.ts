/**
 * `loadConfig` and its precedence chain.
 *
 * Mutation testing found 54 surviving mutants here, all ConditionalExpression,
 * and no test referenced `loadConfig` at all. That matters more than it sounds:
 * precedence controls which wallet address wins. If `x402.config.json` silently
 * overrides an explicitly passed `payTo`, payments go to whatever address the
 * file happens to contain — while the code reads correctly.
 *
 * The rule the tests below pin down: explicit option → environment → file.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig } from "@x402-lens/core";

const EVM = "eip155:84532";
const ADDRESS = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const OTHER_ADDRESS = "0x0000000000000000000000000000000000000001";
const FACILITATOR = "https://x402.org/facilitator";

const directories: string[] = [];

/**
 * Create a temporary directory, optionally with an `x402.config.json`.
 *
 * @param config - File contents to write, or undefined to omit the file
 * @returns Directory path
 */
async function tempDir(config?: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "x402-lens-load-"));
  directories.push(dir);
  if (config !== undefined) {
    const body = typeof config === "string" ? config : JSON.stringify(config);
    await writeFile(join(dir, "x402.config.json"), body, "utf8");
  }
  return dir;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

/** The minimum a config file needs to be usable. */
function fileConfig(overrides: Record<string, unknown> = {}) {
  return {
    facilitatorUrl: FACILITATOR,
    network: EVM,
    payTo: ADDRESS,
    routes: [{ route: "GET /weather", price: "0.001" }],
    ...overrides,
  };
}

describe("file-only configuration", () => {
  it("loads every field from x402.config.json", async () => {
    const dir = await tempDir(fileConfig());
    const config = await loadConfig({ cwd: dir, env: {} });

    expect(config.facilitatorUrl).toBe(FACILITATOR);
    expect(config.network).toBe(EVM);
    expect(config.payTo).toBe(ADDRESS);
    expect(config.routes).toHaveLength(1);
  });

  it("loads networks, timeout and facilitator timeout from the file", async () => {
    const dir = await tempDir(
      fileConfig({
        networks: [EVM],
        maxTimeoutSeconds: 120,
        facilitatorTimeoutMs: 4000,
      }),
    );
    const config = await loadConfig({ cwd: dir, env: {} });

    expect(config.networks).toEqual([EVM]);
    expect(config.maxTimeoutSeconds).toBe(120);
    expect(config.facilitatorTimeoutMs).toBe(4000);
    expect(config.facilitatorHeaders).toBeUndefined();
  });

  it("rejects facilitatorHeaders present only in x402.config.json", async () => {
    const dir = await tempDir(
      fileConfig({ facilitatorHeaders: { verify: { "x-key": "v" } } }),
    );
    await expect(loadConfig({ cwd: dir, env: {} })).rejects.toMatchObject({
      name: "ConfigError",
      field: "facilitatorHeaders",
    });
  });

  it("works with no file at all when env supplies everything", async () => {
    const dir = await tempDir();
    const config = await loadConfig({
      cwd: dir,
      env: {
        X402_FACILITATOR_URL: FACILITATOR,
        X402_NETWORK: EVM,
        X402_PAY_TO: ADDRESS,
        "X402_PRICE__GET_/weather": "0.001",
      },
    });
    expect(config.payTo).toBe(ADDRESS);
  });

  it("skips the file when readConfigFile is false", async () => {
    const dir = await tempDir(fileConfig());
    await expect(
      loadConfig({ cwd: dir, readConfigFile: false, env: {} }),
    ).rejects.toThrow(ConfigError);
  });

  it("reports invalid JSON as a ConfigError naming the file", async () => {
    const dir = await tempDir("{ not json");
    try {
      await loadConfig({ cwd: dir, env: {} });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).field).toBe("x402.config.json");
    }
  });
});

describe("precedence: explicit option beats file", () => {
  it("uses an explicit facilitatorUrl over the file", async () => {
    const dir = await tempDir(fileConfig());
    const config = await loadConfig({
      cwd: dir,
      facilitatorUrl: "https://explicit.example/facilitator",
      env: {},
    });
    expect(config.facilitatorUrl).toBe("https://explicit.example/facilitator");
  });

  it("uses an explicit network over the file", async () => {
    const dir = await tempDir(fileConfig({ network: "eip155:8453" }));
    const config = await loadConfig({ cwd: dir, network: EVM, env: {} });
    expect(config.network).toBe(EVM);
  });

  it("uses an explicit payTo over the file, so the wrong wallet never wins", async () => {
    const dir = await tempDir(fileConfig({ payTo: OTHER_ADDRESS }));
    const config = await loadConfig({ cwd: dir, payTo: ADDRESS, env: {} });
    expect(config.payTo).toBe(ADDRESS);
  });

  it("uses explicit networks over the file", async () => {
    const dir = await tempDir(fileConfig({ networks: ["eip155:8453"] }));
    const config = await loadConfig({ cwd: dir, networks: [EVM], env: {} });
    expect(config.networks).toEqual([EVM]);
  });

  it("uses an explicit routes list over the file", async () => {
    const dir = await tempDir(fileConfig());
    const config = await loadConfig({
      cwd: dir,
      routes: [{ route: "POST /other", price: "2" }],
      env: {},
    });
    expect(config.routes).toEqual([{ method: "POST", path: "/other", price: "2" }]);
  });

  it("uses an explicit timeout over the file", async () => {
    const dir = await tempDir(fileConfig({ maxTimeoutSeconds: 120 }));
    const config = await loadConfig({ cwd: dir, maxTimeoutSeconds: 30, env: {} });
    expect(config.maxTimeoutSeconds).toBe(30);
  });

  it("rejects facilitatorHeaders in x402.config.json even when options also set them", async () => {
    const dir = await tempDir(fileConfig({ facilitatorHeaders: { settle: { a: "1" } } }));
    await expect(
      loadConfig({
        cwd: dir,
        facilitatorHeaders: { verify: { b: "2" } },
        env: {},
      }),
    ).rejects.toMatchObject({
      name: "ConfigError",
      field: "facilitatorHeaders",
      message: expect.stringMatching(/must not be set in x402\.config\.json/i),
    });
  });

  it("accepts the map form of routes in x402.config.json", async () => {
    const dir = await tempDir(
      fileConfig({
        routes: { "GET /weather": "0.001", "POST /generate": "$0.05" },
      }),
    );
    const config = await loadConfig({ cwd: dir, env: {} });

    expect(config.routes).toHaveLength(2);
    expect(config.routes.map(route => `${route.method} ${route.path}`)).toEqual([
      "GET /weather",
      "POST /generate",
    ]);
  });

  it("accepts per-route options in the map form", async () => {
    const dir = await tempDir(
      fileConfig({
        routes: {
          "GET /generate": { price: "$0.05", paymentFlow: "upfront" },
        },
      }),
    );
    const config = await loadConfig({ cwd: dir, env: {} });

    expect(config.routes[0]).toMatchObject({
      method: "GET",
      path: "/generate",
      paymentFlow: "upfront",
    });
  });

  it("rejects a routes value that is neither an array nor a map", async () => {
    const dir = await tempDir(fileConfig({ routes: "GET /weather" }));
    await expect(loadConfig({ cwd: dir, env: {} })).rejects.toThrow(
      /routes must be an array .* or a map/,
    );
  });

  it("rejects a non-object route entry in the array form", async () => {
    const dir = await tempDir(fileConfig({ routes: ["GET /weather"] }));
    await expect(loadConfig({ cwd: dir, env: {} })).rejects.toThrow(
      /routes\[0\] must be an object/,
    );
  });

  it("uses an explicit facilitator timeout over the file", async () => {
    const dir = await tempDir(fileConfig({ facilitatorTimeoutMs: 9000 }));
    const config = await loadConfig({ cwd: dir, facilitatorTimeoutMs: 1500, env: {} });
    expect(config.facilitatorTimeoutMs).toBe(1500);
  });
});

describe("precedence: file beats environment", () => {
  it("uses the file facilitator over the env var", async () => {
    const dir = await tempDir(fileConfig());
    const config = await loadConfig({
      cwd: dir,
      env: { X402_FACILITATOR_URL: "https://env.example/facilitator" },
    });
    expect(config.facilitatorUrl).toBe(FACILITATOR);
  });

  it("uses the file network over the env var", async () => {
    const dir = await tempDir(fileConfig({ network: "eip155:8453" }));
    const config = await loadConfig({ cwd: dir, env: { X402_NETWORK: EVM } });
    expect(config.network).toBe("eip155:8453");
  });

  it("uses the file payTo over the env var", async () => {
    const dir = await tempDir(fileConfig());
    const config = await loadConfig({ cwd: dir, env: { X402_PAY_TO: OTHER_ADDRESS } });
    expect(config.payTo).toBe(ADDRESS);
  });

  it("uses the file routes over X402_PRICE__ variables", async () => {
    const dir = await tempDir(fileConfig());
    const config = await loadConfig({
      cwd: dir,
      env: { "X402_PRICE__GET_/other": "9" },
    });
    expect(config.routes[0]?.path).toBe("/weather");
  });

  it("uses the file timeout over the env var", async () => {
    const dir = await tempDir(fileConfig({ maxTimeoutSeconds: 120 }));
    const config = await loadConfig({ cwd: dir, env: { X402_MAX_TIMEOUT_SECONDS: "30" } });
    expect(config.maxTimeoutSeconds).toBe(120);
  });

  it("still applies the env facilitator token when the file has no headers", async () => {
    // Auth is the one place env wins over a file that says nothing about it.
    const dir = await tempDir(fileConfig());
    const config = await loadConfig({ cwd: dir, env: { X402_FACILITATOR_TOKEN: "tok" } });
    expect(config.facilitatorHeaders?.settle).toEqual({ Authorization: "Bearer tok" });
  });

  it("rejects facilitatorHeaders in x402.config.json instead of taking them over the env token", async () => {
    const dir = await tempDir(fileConfig({ facilitatorHeaders: { settle: { a: "1" } } }));
    await expect(
      loadConfig({ cwd: dir, env: { X402_FACILITATOR_TOKEN: "tok" } }),
    ).rejects.toMatchObject({
      name: "ConfigError",
      field: "facilitatorHeaders",
    });
  });
});

describe("a partially specified file", () => {
  it("fills the gaps from the environment", async () => {
    // A file that only sets routes is a common shape: prices live with the code,
    // secrets live in the environment.
    const dir = await tempDir({ routes: [{ route: "GET /weather", price: "0.001" }] });
    const config = await loadConfig({
      cwd: dir,
      env: {
        X402_FACILITATOR_URL: FACILITATOR,
        X402_NETWORK: EVM,
        X402_PAY_TO: ADDRESS,
      },
    });
    expect(config.facilitatorUrl).toBe(FACILITATOR);
    expect(config.network).toBe(EVM);
    expect(config.payTo).toBe(ADDRESS);
  });

  it("reports the missing field rather than inventing one", async () => {
    const dir = await tempDir({ routes: [{ route: "GET /weather", price: "0.001" }] });
    try {
      await loadConfig({ cwd: dir, env: { X402_NETWORK: EVM, X402_PAY_TO: ADDRESS } });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as ConfigError).field).toBe("facilitatorUrl");
    }
  });
});
