/**
 * The last five audit findings.
 *
 * Two were real correctness bugs in the response path (`Vary` dropping what the
 * app set, and wildcard routes not matching deep paths), one was a dead branch
 * that mislabelled its case, and two were contract gaps where `--json` or a
 * warning was missing on a path that needed it.
 */

import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { mergeCorsHeaders, pathMatchesPattern } from "@x402-lens/server";
import { paymentLens } from "@x402-lens/express";
import { checkEndpoint } from "../packages/cli/src/commands/watch.js";
import { startMockFacilitator } from "./helpers/mockFacilitator.js";
import { runCli } from "./helpers/runCli.js";

const EVM = "eip155:84532";
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";

describe("audit: Vary is a list header", () => {
  it("keeps what the application already set", () => {
    // Replacing it dropped `Accept-Encoding`, so a cache could serve a gzipped
    // body to a client that never asked for one — a correctness bug in the
    // response, not a header detail.
    const merged = mergeCorsHeaders(() => "Accept-Encoding, Origin", { Vary: "Origin" });

    expect(merged.Vary).toContain("Accept-Encoding");
    expect(merged.Vary).toContain("Origin");
  });

  it("does not duplicate a value present in both", () => {
    const merged = mergeCorsHeaders(() => "Origin", { Vary: "Origin" });
    expect(merged.Vary?.split("Origin").length).toBe(2);
  });

  it("still replaces Access-Control-Allow-Origin, which is a singleton", () => {
    // A comma-joined ACAO is a value browsers reject outright.
    const merged = mergeCorsHeaders(() => "https://old.example", {
      "Access-Control-Allow-Origin": "https://new.example",
    });
    expect(merged["Access-Control-Allow-Origin"]).toBe("https://new.example");
    expect(merged["Access-Control-Allow-Origin"]).not.toContain(",");
  });
});

describe("audit: wildcard routes match deep paths, and params need a value", () => {
  it("matches a multi-segment tail under a trailing *", () => {
    // The SDK's own routing matches `/api/a/b` for `/api/*`, but this matcher
    // required equal segment counts — so `grant` received no route config on
    // exactly the deep paths a wildcard protects, and fell through to payment.
    expect(pathMatchesPattern("/api/*", "/api/a/b")).toBe(true);
    expect(pathMatchesPattern("/api/*", "/api/a")).toBe(true);
  });

  it("does not match the bare prefix", () => {
    // `/api/*` means "something under /api", not `/api` itself; matching the
    // prefix would hand a grant callback a different resource's config.
    expect(pathMatchesPattern("/api/*", "/api")).toBe(false);
    expect(pathMatchesPattern("/api/*", "/apix")).toBe(false);
  });

  it("requires a non-empty segment for a :param", () => {
    // `/users/:id` matching `/users/` would give a grant callback a config for a
    // path with no id.
    expect(pathMatchesPattern("/users/:id", "/users/42")).toBe(true);
    expect(pathMatchesPattern("/users/:id", "/users/")).toBe(false);
  });

  it("still rejects a partial segment match", () => {
    expect(pathMatchesPattern("/users/id", "/users/42")).toBe(false);
  });

  it("matches a * in the middle of a pattern", () => {
    expect(pathMatchesPattern("/a/*/c", "/a/b/c")).toBe(true);
    expect(pathMatchesPattern("/a/*/c", "/a/b/d")).toBe(false);
  });
});

describe("audit: a corrupt challenge header is not 'paywall gone'", () => {
  it("reports challenge_unreadable, not paywall_gone", async () => {
    // `challenge_unreadable` was declared and never constructed, so this case was
    // reported as `paywall_gone` — claiming "clients will be charged nothing"
    // about a server whose problem is one bad header away from working.
    const server = createServer((_req, res) => {
      res.writeHead(402, {
        "payment-required": "!!!not-base64!!!",
        "content-type": "application/json",
      });
      res.end("{}");
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as AddressInfo).port;

    try {
      const result = await checkEndpoint({ url: `http://127.0.0.1:${port}/x` }, undefined);

      expect(result.ok).toBe(false);
      expect(result.drift.map(item => item.kind)).toContain("challenge_unreadable");
      expect(result.drift.map(item => item.kind)).not.toContain("paywall_gone");
    } finally {
      await new Promise<void>((done, fail) => server.close(error => (error ? fail(error) : done())));
    }
  }, 20_000);
});


describe("audit: --json holds on every error path", () => {
  it("emits JSON when explain cannot read its input file", async () => {
    // `inspect` had a JSON-aware catch; `explain` and `add` did not, so a machine
    // reader got an empty stdout and a human sentence on stderr — the same shape
    // as success.
    const result = await runCli(["explain", "--json", "--challenge", "@definitely-missing.json"]);

    expect(result.stdout.trim().length).toBeGreaterThan(0);
    const parsed = JSON.parse(result.stdout) as { error?: string; exitCode?: number };
    expect(parsed.error).toContain("ENOENT");
    expect(parsed.exitCode).toBe(1);
  }, 20_000);

  it("emits JSON when add cannot read the source file", async () => {
    const result = await runCli(["add", "GET /x", "--file", "no-such-file.ts", "--price", "0.001", "--json"]);

    expect(result.stdout.trim().length).toBeGreaterThan(0);
    const parsed = JSON.parse(result.stdout) as { error?: string };
    expect(parsed.error).toContain("ENOENT");
  }, 20_000);
});

describe("audit: a route key with the mount prefix warns", () => {
  it("warns when the key includes the prefix Express strips", async () => {
    // Inside `app.use('/acme', router)` Express reports `/weather`, so a key
    // written as `GET /acme/weather` matches nothing while the router still
    // serves it — measured: 200 with the protected payload, no event, no error.
    // The behaviour is the SDK's; the warning is the lens's job.
    const facilitator = await startMockFacilitator({ network: EVM });
    const lens = paymentLens({
      facilitatorUrl: facilitator.url,
      network: EVM,
      payTo: PAY_TO,
      routes: { "GET /acme/weather": "$0.001" },
      sinks: { console: false },
    });

    const warnings: string[] = [];
    const onWarning = (warning: Error): void => {
      warnings.push(warning.message);
    };
    process.on("warning", onWarning);

    const app = express();
    const router = express.Router();
    router.use(lens.middleware);
    router.get("/weather", (_req, res) => res.json({ secret: true }));
    app.use("/acme", router);

    const server = createServer(app);
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as AddressInfo).port;

    try {
      await fetch(`http://127.0.0.1:${port}/acme/weather`);
      await new Promise(done => setTimeout(done, 150));

      expect(warnings.some(message => message.includes("mount prefix"))).toBe(true);
    } finally {
      process.off("warning", onWarning);
      await lens.close();
      await facilitator.close();
      await new Promise<void>((done, fail) => server.close(error => (error ? fail(error) : done())));
    }
  }, 20_000);
});
