/**
 * `add` must never write a file that cannot run.
 *
 * On a router-only module it inserted `app.use(lens.middleware)` where no `app`
 * exists, reported "Updated <file>", and exited 0 — so the developer's next step
 * was an import-time `ReferenceError: app is not defined` in code the tool had
 * just written.
 *
 * Mounting on the router instead is not the fix: routers are normally mounted
 * under a prefix, and the lens matches the path it is given, so the protection
 * would silently miss every request — a worse outcome than a crash. The command
 * therefore refuses, before writing anything, and prints the two lines to place
 * where the app is assembled.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AddError, addProtection } from "../packages/cli/src/commands/add.js";

const dirs: string[] = [];

async function fileWith(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lens-add-"));
  dirs.push(dir);
  const file = join(dir, "routes.ts");
  await writeFile(file, contents, "utf8");
  return file;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const ROUTER_ONLY = `import { Router } from "express";

const router = Router();

router.get("/weather", (_req, res) => {
  res.json({ weather: "sunny" });
});

export default router;
`;

const APP_FILE = `import express from "express";

const app = express();

app.get("/weather", (_req, res) => {
  res.json({ weather: "sunny" });
});

app.listen(3000);
`;

describe("add: router-only files", () => {
  it("refuses instead of writing a mount that cannot run", async () => {
    const file = await fileWith(ROUTER_ONLY);

    await expect(
      addProtection({ file, route: "GET /weather", price: "0.001", write: true }),
    ).rejects.toThrow(AddError);
  });

  it("leaves the file untouched when it refuses", async () => {
    const file = await fileWith(ROUTER_ONLY);

    await addProtection({ file, route: "GET /weather", price: "0.001", write: true }).catch(
      () => undefined,
    );

    // The whole point: a refusal must not be a half-applied edit.
    expect(await readFile(file, "utf8")).toBe(ROUTER_ONLY);
  });

  it("names the receiver and says where the mount belongs", async () => {
    const file = await fileWith(ROUTER_ONLY);

    const error = await addProtection({ file, route: "GET /weather", price: "0.001", write: true })
      .then(() => undefined)
      .catch((thrown: unknown) => thrown as Error);

    expect(error?.message).toMatch(/declares this route on `router`/);
    expect(error?.message).toMatch(/app\.use\(lens\.middleware\)/);
  });

  it("refuses on a `server` receiver too", async () => {
    const file = await fileWith(`import express from "express";
import { createServer } from "node:http";

const server = express();
server.get("/weather", (_req, res) => res.json({ ok: true }));
`);

    await expect(
      addProtection({ file, route: "GET /weather", price: "0.001", write: true }),
    ).rejects.toThrow(/declares this route on `server`/);
  });
});

describe("add: app files still work", () => {
  it("mounts on the app and writes a file that defines it", async () => {
    const file = await fileWith(APP_FILE);

    const result = await addProtection({
      file,
      route: "GET /weather",
      price: "0.001",
      write: true,
    });
    expect(result.exitCode).toBe(0);

    const after = await readFile(file, "utf8");
    expect(/\bconst app\b/.test(after)).toBe(true);
    expect(after).toContain("app.use(lens.middleware);");
    expect(after).toContain('paymentLens({ routes: { "GET /weather": "0.001" } })');
  });
});
