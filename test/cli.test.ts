/**
 * CLI behaviour, tested as functions rather than through a spawned process so
 * failures point at a line instead of a subprocess exit code.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddError, addProtection, unifiedDiff } from "../packages/cli/src/commands/add";
import { InputError, parseJsonOrBase64 } from "../packages/cli/src/input";
import { parseArgs, flagEnabled, flagValue } from "../packages/cli/src/args";

const temporaryDirs: string[] = [];

async function tempFile(contents: string, name = "server.ts"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "x402-lens-"));
  temporaryDirs.push(dir);
  const path = join(dir, name);
  await writeFile(path, contents, "utf8");
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })),
  );
});

const EXPRESS_APP = `import express from "express";
import { something } from "./other";

const app = express();
app.use(express.json());

app.get("/weather", (_req, res) => {
  res.json({ weather: "sunny" });
});

app.listen(3000);
`;

describe("parseArgs", () => {
  it("splits command, positionals, and flags", () => {
    const args = parseArgs(["inspect", "https://example.com/x", "--method", "POST"]);
    expect(args.command).toBe("inspect");
    expect(args.positionals).toEqual(["https://example.com/x"]);
    expect(flagValue(args, "method")).toBe("POST");
  });

  it("supports --key=value", () => {
    const args = parseArgs(["explain", "--price=0.01"]);
    expect(flagValue(args, "price")).toBe("0.01");
  });

  it("treats a trailing flag as boolean", () => {
    const args = parseArgs(["add", "--write"]);
    expect(flagEnabled(args, "write")).toBe(true);
  });
});

describe("parseJsonOrBase64", () => {
  it("parses raw JSON", () => {
    expect(parseJsonOrBase64('{"x402Version":2}', "input")).toEqual({ x402Version: 2 });
  });

  it("parses base64-encoded JSON", () => {
    const encoded = Buffer.from('{"a":1}', "utf8").toString("base64");
    expect(parseJsonOrBase64(encoded, "input")).toEqual({ a: 1 });
  });

  it("parses URL-safe base64", () => {
    const json = '{"k":"???>>>"}';
    const encoded = Buffer.from(json, "utf8").toString("base64url");
    expect(parseJsonOrBase64(encoded, "input")).toEqual({ k: "???>>>" });
  });

  it("rejects garbage with an actionable message", () => {
    expect(() => parseJsonOrBase64("not json at all", "--challenge")).toThrow(InputError);
    try {
      parseJsonOrBase64("not json at all", "--challenge");
    } catch (error) {
      expect((error as Error).message).toContain("--challenge");
      expect((error as Error).message).toContain("@file");
    }
  });

  it("rejects an empty value", () => {
    expect(() => parseJsonOrBase64("   ", "input")).toThrow(/empty/);
  });
});

describe("addProtection", () => {
  it("produces a diff without writing by default", async () => {
    const path = await tempFile(EXPRESS_APP);
    const result = await addProtection({ file: path, route: "GET /weather", price: "0.001" });

    expect(result.changed).toBe(true);
    expect(result.diff).toContain("+import { paymentLens }");
    expect(result.diff).toContain("+const lens = paymentLens(");
    expect(result.diff).toContain("+app.use(lens.middleware);");
    // The lens is mounted once globally; its route map decides what is paid.
    // A per-route guard as well would run the same check twice.
    expect(result.diff).not.toContain("lens.middleware,");

    // The file on disk must be untouched.
    expect(await readFile(path, "utf8")).toBe(EXPRESS_APP);
  });

  it("writes a file that mentions the route and the mount", async () => {
    const path = await tempFile(EXPRESS_APP);
    await addProtection({ file: path, route: "GET /weather", price: "0.001", write: true });

    const updated = await readFile(path, "utf8");
    expect(updated).toContain('import { paymentLens } from "@x402-lens/express";');
    expect(updated).toContain('"GET /weather": "0.001"');
    expect(updated).toContain("app.use(lens.middleware);");
    // The original handler must still be there, unmodified.
    expect(updated).toContain('app.get("/weather", (_req, res) => {');
    expect(updated).toContain('res.json({ weather: "sunny" });');
  });

  it("is idempotent", async () => {
    const path = await tempFile(EXPRESS_APP);
    await addProtection({ file: path, route: "GET /weather", price: "0.001", write: true });
    const afterFirst = await readFile(path, "utf8");

    const second = await addProtection({ file: path, route: "GET /weather", price: "0.001", write: true });
    expect(second.changed).toBe(false);
    expect(await readFile(path, "utf8")).toBe(afterFirst);
  });

  it("leaves exactly one blank line around the inserted block in a CRLF file", async () => {
    const crlf = EXPRESS_APP.split("\n").join("\r\n");
    const path = await tempFile(crlf);
    await addProtection({ file: path, route: "GET /weather", price: "0.001", write: true });

    const updated = await readFile(path, "utf8");
    // No doubled blank lines, which is what a naive insertion produces when the
    // source uses CRLF and the pattern only knew about LF.
    expect(updated).not.toContain("\r\n\r\n\r\n");
    expect(updated).toContain("app.use(lens.middleware);");
  });

  it("refuses a non-Express file with an explicit reason", async () => {
    const path = await tempFile('import Fastify from "fastify";\nconst app = Fastify();\n');
    await expect(
      addProtection({ file: path, route: "GET /weather", price: "0.001" }),
    ).rejects.toThrow(AddError);
  });

  it("explains the manual fallback when the route is not found", async () => {
    const path = await tempFile(EXPRESS_APP);
    try {
      await addProtection({ file: path, route: "POST /missing", price: "0.001" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as Error).message).toContain("app.use(lens.middleware);");
      expect((error as Error).message).toContain("POST /missing");
    }
  });

  it("refuses to edit a compiled file", async () => {
    const path = await tempFile(EXPRESS_APP, "server.py");
    await expect(
      addProtection({ file: path, route: "GET /weather", price: "0.001" }),
    ).rejects.toThrow(/not a JavaScript or TypeScript file/);
  });
});

describe("unifiedDiff", () => {
  it("marks insertions and keeps context", () => {
    const diff = unifiedDiff("f.ts", "a\nb\n", "a\nnew\nb\n");
    expect(diff).toContain("--- a/f.ts");
    expect(diff).toContain("+++ b/f.ts");
    expect(diff).toContain("+new");
    expect(diff).toContain(" a");
  });

  it("returns an empty string when nothing changed", () => {
    expect(unifiedDiff("f.ts", "same\n", "same\n")).toBe("");
  });
});
