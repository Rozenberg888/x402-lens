/**
 * Defects found by the full audit, each pinned so it cannot return.
 *
 * Every test here corresponds to something observed by running the code, not by
 * reading it — which is the only reason they exist as a group. Three of these
 * were violations of promises in the README:
 *
 *   1. "Config loading that refuses to guess" — but `-1`, `0`, `abc` and
 *      `1.5.2` were all accepted as prices, and three of them threw inside the
 *      SDK per request, so every buyer got HTTP 500 instead of a 402.
 *   2. `--json` was documented as machine-readable output, but a malformed URL
 *      to `inspect` produced an empty stdout and a stack-trace-shaped stderr.
 *   3. `watch --interval` looped forever with no signal handling, so Ctrl+C
 *      killed it wherever it happened to be.
 */

import { describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import express from "express";
import { ConfigError, resolveConfig } from "@x402-lens/core";
import { paymentLens } from "@x402-lens/express";
import { startMockFacilitator } from "./helpers/mockFacilitator.js";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "packages", "cli", "dist", "index.js");

const BASE = {
  facilitatorUrl: "https://facilitator.example.com",
  network: "eip155:84532",
  payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
};

/** Resolve a config with one route priced as given. */
function withPrice(price: string) {
  return resolveConfig({ ...BASE, routes: { "GET /a": price } });
}

describe("audit: a price that cannot work is refused at config time", () => {
  it("rejects a negative price", () => {
    // The SDK's parsePrice throws on this, once per request: every buyer gets
    // 500 instead of a 402, and the cause is a startup mistake that was allowed
    // through.
    expect(() => withPrice("-1")).toThrow(ConfigError);
    expect(() => withPrice("-0.001")).toThrow(/not a decimal amount/);
  });

  it("rejects a zero price", () => {
    // A zero price produces a valid 402 whose amount is 0. The route looks paid
    // and charges nothing, which is worse than a crash because it looks healthy.
    expect(() => withPrice("0")).toThrow(/not a positive amount/);
    expect(() => withPrice("0.0")).toThrow(/not a positive amount/);
  });

  it("rejects a non-numeric price", () => {
    expect(() => withPrice("abc")).toThrow(/not a decimal amount/);
  });

  it("rejects a number with two decimal points", () => {
    expect(() => withPrice("1.5.2")).toThrow(/not a decimal amount/);
  });

  it("rejects scientific notation", () => {
    // `1e-9` is a legitimate way to write a tiny amount and an illegitimate way
    // to write a price: the SDK does not parse it, so it fails per request.
    expect(() => withPrice("1e-9")).toThrow(/not a decimal amount/);
  });

  it("rejects a negative amount in an explicit asset price", () => {
    expect(() =>
      resolveConfig({
        ...BASE,
        routes: [{ route: "GET /a", price: { asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", amount: "-5" } }],
      }),
    ).toThrow(ConfigError);
  });

  it("rejects a zero amount in an explicit asset price", () => {
    // The map value is a route options object, so the asset price lives under
    // `price` — `{ "GET /a": { asset, amount } }` is a different (invalid) shape
    // and would be rejected for the wrong reason.
    expect(() =>
      resolveConfig({
        ...BASE,
        routes: {
          "GET /a": { price: { asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", amount: "0" } },
        },
      }),
    ).toThrow(/zero amount|is "0"/);
  });

  it("still accepts every legitimate price form", () => {
    // The check must not become a nuisance: these are all valid and common.
    for (const price of ["0.001", "$0.001", "10", "0.000001", "$1.50"]) {
      expect(() => withPrice(price), `price ${JSON.stringify(price)} should be accepted`).not.toThrow();
    }
  });

  it("reports the offending route, not just 'invalid price'", () => {
    // Without the route name, a config with ten routes gives no clue which one
    // to fix.
    expect(() => withPrice("-1")).toThrow(/routes\[0\]\.price/);
  });
});

describe("audit: an invalid price never reaches a buyer as HTTP 500", () => {
  it("fails at construction, so no request can hit the SDK's throw", async () => {
    const facilitator = await startMockFacilitator({ network: "eip155:84532" });
    try {
      // The point: this must throw here, at construction. If it did not, the
      // first request would answer 500 — verified by hand before the fix.
      expect(() =>
        paymentLens({
          facilitatorUrl: facilitator.url,
          network: "eip155:84532",
          payTo: BASE.payTo,
          routes: { "GET /a": "-1" },
          sinks: { console: false },
        }),
      ).toThrow(ConfigError);
    } finally {
      await facilitator.close();
    }
  });

  it("answers 402, not 500, for a valid price", async () => {
    const facilitator = await startMockFacilitator({ network: "eip155:84532" });
    const lens = paymentLens({
      facilitatorUrl: facilitator.url,
      network: "eip155:84532",
      payTo: BASE.payTo,
      routes: { "GET /a": "0.001" },
      sinks: { console: false },
    });
    let server: Server | undefined;
    try {
      const app = express();
      app.use(lens.middleware);
      app.get("/a", (_req, res) => res.json({ ok: true }));
      server = createServer(app);
      await new Promise<void>(done => server?.listen(0, "127.0.0.1", done));
      const port = (server.address() as AddressInfo).port;

      const response = await fetch(`http://127.0.0.1:${port}/a`);
      expect(response.status).toBe(402);
      expect(response.headers.get("payment-required")).toBeTruthy();
    } finally {
      if (server) {
        await new Promise<void>((done, fail) =>
          server?.close(error => (error ? fail(error) : done())),
        );
      }
      await lens.close();
      await facilitator.close();
    }
  });
});

/**
 * Run the built CLI and capture stdout, stderr and exit code.
 *
 * The defects below were in argument handling and process lifecycle, so they are
 * only visible by executing the binary — a unit test on `main()` would not show
 * that a stack trace reached stderr.
 */
function runCli(args: string[], timeoutMs = 20_000): Promise<{
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

describe("audit: inspect reports a bad URL as a message, not a crash", () => {
  it("explains that the URL needs a scheme", async () => {
    const result = await runCli(["inspect", "not-a-url"]);

    // Before the fix this was "Unexpected error: Failed to parse URL from …",
    // which names the symptom and not the mistake.
    expect(result.stderr).toContain("is not a valid URL");
    expect(result.stderr).toContain("https://");
    expect(result.stderr).not.toMatch(/Unexpected error/);
  });

  it("exits 1, not 2", async () => {
    // 2 means "bad usage" — but a URL that is well-typed and unreachable is a
    // failed check. Distinguishing them matters for a CI gate.
    const result = await runCli(["inspect", "not-a-url"]);
    expect(result.code).toBe(1);
  });

  it("still emits valid JSON on stdout in --json mode", async () => {
    // This was the sharper half of the defect: a machine reader got an empty
    // stream and a human sentence on stderr, indistinguishable from success.
    const result = await runCli(["inspect", "not-a-url", "--json"]);

    expect(result.stdout.trim().length).toBeGreaterThan(0);
    const parsed = JSON.parse(result.stdout) as { error?: string; exitCode?: number };
    expect(parsed.error).toContain("is not a valid URL");
    expect(parsed.exitCode).toBe(1);
  });

  it("reports a refused connection as unreachable, not as a bad URL", async () => {
    // The two failures need different fixes, so they must read differently.
    const result = await runCli(["inspect", "http://127.0.0.1:1", "--timeout", "2000"]);
    expect(result.stderr).toContain("Could not reach");
    expect(result.stderr).not.toContain("is not a valid URL");
  });
});

describe("audit: watch --interval exits on a signal", () => {
  it("stops on SIGINT instead of running forever", async () => {
    // The loop was `for (;;)` with no handler: Ctrl+C killed the process
    // wherever it was, with no confirmation and no chance to see the last result.
    const child = spawn(
      process.execPath,
      [CLI, "watch", "http://127.0.0.1:1", "--interval", "1", "--timeout", "300"],
      { cwd: ROOT },
    );
    const closed = new Promise<number>(done => child.on("close", code => done(code ?? 1)));

    // Let at least one check run, then interrupt.
    await new Promise(done => setTimeout(done, 2500));
    child.kill("SIGINT");

    const code = await Promise.race([
      closed,
      new Promise<number>(done => setTimeout(() => done(-1), 10_000)),
    ]);
    child.kill();

    expect(code).not.toBe(-1);
  }, 20_000);
});
