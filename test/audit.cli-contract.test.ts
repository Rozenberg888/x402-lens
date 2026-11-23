/**
 * CLI contract defects from the second audit round.
 *
 * These are the findings that came out of executing the built binary against
 * adversarial input, not from reading the code. Several were argument-parsing
 * bugs with a shared root: the parser could not know which flags take a value,
 * so it paired any `--flag` with the next non-`--` token. That single gap
 * produced five separate defects, three of them dangerous.
 */

import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { flagEnabled, parseArgs } from "../packages/cli/src/args.js";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "packages", "cli", "dist", "index.js");

describe("args: boolean flags do not consume the next token", () => {
  it("keeps the URL positional after --json", () => {
    // The natural argument order. Before the schema, `--json` took the URL as its
    // value, leaving no positional and failing with "inspect requires a URL".
    const parsed = parseArgs(["inspect", "--json", "https://api.example/x"]);
    expect(parsed.positionals).toEqual(["https://api.example/x"]);
    expect(parsed.flags.json).toBe(true);
    expect(parsed.errors).toEqual([]);
  });

  it("keeps the URL positional after --once", () => {
    const parsed = parseArgs(["watch", "--once", "https://api.example/x"]);
    expect(parsed.positionals).toEqual(["https://api.example/x"]);
    expect(parsed.flags.once).toBe(true);
  });

  it("still takes a value for a flag that needs one", () => {
    const parsed = parseArgs(["inspect", "https://x.test/a", "--timeout", "5000"]);
    expect(parsed.flags.timeout).toBe("5000");
    expect(parsed.positionals).toEqual(["https://x.test/a"]);
  });

  it("accepts --flag=value for a value flag", () => {
    const parsed = parseArgs(["inspect", "https://x.test/a", "--timeout=5000"]);
    expect(parsed.flags.timeout).toBe("5000");
    expect(parsed.errors).toEqual([]);
  });
});

describe("args: a boolean flag cannot be given a value", () => {
  it("rejects --write false instead of treating it as enabled", () => {
    // `flagEnabled` used to test presence, and `"false"` is present — so
    // `--write false`, clearly intended as a dry run, rewrote the source file.
    const parsed = parseArgs(["add", "GET /x", "--write", "false"]);
    expect(parsed.errors.join(" ")).toMatch(/takes no value/);
    expect(flagEnabled(parsed, "write")).toBe(false);
  });

  it("rejects --json=false", () => {
    const parsed = parseArgs(["inspect", "https://x.test/a", "--json=false"]);
    expect(parsed.errors.join(" ")).toMatch(/takes no value/);
  });
});

describe("args: unknown flags are errors, not silently ignored", () => {
  it("reports a typo'd flag", () => {
    // `--timeoutt 5` used to exit 0 with the default 15s timeout, so a user
    // debugging a slow endpoint believed their flag took effect.
    const parsed = parseArgs(["inspect", "https://x.test/a", "--timeoutt", "5"]);
    expect(parsed.errors.join(" ")).toContain('Unknown flag "--timeoutt"');
  });

  it("reports a missing value for a value flag", () => {
    const parsed = parseArgs(["inspect", "https://x.test/a", "--timeout"]);
    expect(parsed.errors.join(" ")).toContain("--timeout requires a value");
  });

  it("treats a following flag as the missing value, not as the value", () => {
    const parsedArgs = parseArgs(["inspect", "https://x.test/a", "--timeout", "--json"]);
    expect(parsedArgs.errors.join(" ")).toContain("--timeout requires a value");
    expect(parsedArgs.flags.json).toBe(true);
  });
});

describe("args: -- ends flag parsing", () => {
  it("treats everything after -- as positional", () => {
    const parsed = parseArgs(["inspect", "--", "--not-a-flag"]);
    expect(parsed.positionals).toEqual(["--not-a-flag"]);
    expect(parsed.errors).toEqual([]);
  });
});

/** Run the built CLI and capture everything. */
function runCli(args: string[], timeoutMs = 15_000): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise(resolvePromise => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => (stdout += String(chunk)));
    child.stderr.on("data", chunk => (stderr += String(chunk)));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("close", code => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

describe("cli: invalid numeric arguments are usage errors", () => {
  it("rejects --timeout with a non-number as exit 2", async () => {
    // It used to reach `AbortSignal.timeout`, throw RangeError, and be reported
    // as "Could not reach <url>" with exit 1 — blaming the endpoint for a local
    // typo.
    const result = await runCli(["inspect", "http://127.0.0.1:1", "--timeout", "abc"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--timeout must be a positive integer");
    expect(result.stderr).not.toContain("Could not reach");
  });

  it("rejects --timeout 0 as exit 2", async () => {
    const result = await runCli(["inspect", "http://127.0.0.1:1", "--timeout", "0"]);
    expect(result.code).toBe(2);
  });

  it("rejects --interval above the setTimeout ceiling as exit 2", async () => {
    // Node clamps a delay above 2^23-1 ms to 1 ms, so this became a ~1 ms poll
    // loop: hundreds of requests to the monitored endpoint.
    const result = await runCli(["watch", "http://127.0.0.1:1", "--interval", "3000000"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--interval must be at most");
  });
});

describe("cli: an unknown flag stops the command", () => {
  it("exits 2 rather than running with defaults", async () => {
    const result = await runCli(["inspect", "http://127.0.0.1:1", "--timeoutt", "5"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Unknown flag");
  });
});

describe("cli: inspect surfaces error-level findings in the exit code", () => {
  it("exits 1 when a finding is an error, even though the challenge parses", async () => {
    // `extra.version` as a number produces `eip712_domain_mismatch` with severity
    // error. The old exit code ignored findings entirely, so inspect printed
    // "ERROR …" and exited 0 — a CI gate passed a paywall the tool had just
    // declared broken.
    const challenge = {
      x402Version: 2,
      resource: { url: "https://api.example/x" },
      accepts: [
        {
          scheme: "exact",
          network: "eip155:84532",
          asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
          amount: "1000",
          maxTimeoutSeconds: 60,
          extra: { name: "USDC", version: 2 },
        },
      ],
    };
    const headers = {
      "payment-required": Buffer.from(JSON.stringify(challenge)).toString("base64"),
      "content-type": "application/json",
      "access-control-expose-headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE",
      "access-control-allow-headers": "Content-Type, PAYMENT-SIGNATURE",
      "access-control-allow-origin": "*",
    };
    const server = createServer((_req, res) => {
      res.writeHead(402, headers);
      res.end(JSON.stringify(challenge));
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as AddressInfo).port;

    try {
      const result = await runCli(["inspect", `http://127.0.0.1:${port}/x`, "--json"]);
      expect(result.code).toBe(1);
      const parsed = JSON.parse(result.stdout) as { exitCode?: number };
      expect(parsed.exitCode).toBe(1);
    } finally {
      await new Promise<void>((done, fail) =>
        server.close(error => (error ? fail(error) : done())),
      );
    }
  }, 20_000);
});

describe("cli: watch treats a non-402 as broken", () => {
  it("reports ok:false for a 500 that carries a challenge", async () => {
    // A 5xx with a PAYMENT-REQUIRED header used to be "healthy" because only the
    // presence of a challenge was checked. That is precisely the outage class a
    // synthetic monitor exists to catch, and it raised no alert.
    const challenge = {
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: "eip155:84532",
          asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
          amount: "1000",
          maxTimeoutSeconds: 60,
        },
      ],
    };
    const server = createServer((_req, res) => {
      res.writeHead(500, {
        "payment-required": Buffer.from(JSON.stringify(challenge)).toString("base64"),
        "content-type": "application/json",
      });
      res.end("{}");
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as AddressInfo).port;

    try {
      const result = await runCli(["watch", `http://127.0.0.1:${port}/x`, "--json"]);
      const parsed = JSON.parse(result.stdout) as { results: Array<{ ok: boolean; status: number }> };
      expect(parsed.results[0]?.status).toBe(500);
      expect(parsed.results[0]?.ok).toBe(false);
      expect(result.code).toBe(1);
    } finally {
      await new Promise<void>((done, fail) =>
        server.close(error => (error ? fail(error) : done())),
      );
    }
  }, 20_000);
});

describe("cli: a malformed challenge does not crash inspect", () => {
  it("survives accepts: [null], accepts: [{}], accepts as a string, and a null body", async () => {
    // The tool exists to diagnose broken servers, so a malformed challenge is the
    // expected input. Each of these used to throw a TypeError that the CLI
    // reported as "Could not reach <url>", blaming the connection for the body.
    const bodies: unknown[] = [
      { x402Version: 2, accepts: [null] },
      { x402Version: 2, accepts: [{}] },
      { x402Version: 2, accepts: "nope" },
      { x402Version: 2 },
      null,
    ];

    for (const body of bodies) {
      const server = createServer((_req, res) => {
        res.writeHead(402, {
          "payment-required": Buffer.from(JSON.stringify(body)).toString("base64"),
          "content-type": "application/json",
        });
        res.end(JSON.stringify(body));
      });
      await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
      const port = (server.address() as AddressInfo).port;

      try {
        const result = await runCli(["inspect", `http://127.0.0.1:${port}/x`, "--json"]);
        // Whatever the body, the tool must answer rather than crash, and must not
        // describe its own TypeError as a network problem.
        expect(result.stdout.trim().length, `body ${JSON.stringify(body)}`).toBeGreaterThan(0);
        expect(result.stdout).not.toContain("Cannot read properties");
        expect(result.code).toBe(1);
      } finally {
        await new Promise<void>((done, fail) =>
          server.close(error => (error ? fail(error) : done())),
        );
      }
    }
  }, 30_000);
});
