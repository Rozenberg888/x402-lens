/**
 * `add` on files that already carry a lens, plus the formatting cases that a
 * naive insertion gets wrong.
 *
 * The command refuses more than it rewrites, so these tests pin both sides:
 * what it edits and what it declines with instructions instead.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddError, addProtection } from "../packages/cli/src/commands/add";

const temporaryDirs: string[] = [];

async function tempFile(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "x402-lens-add-"));
  temporaryDirs.push(dir);
  const path = join(dir, "server.ts");
  await writeFile(path, contents, "utf8");
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })),
  );
});

const TWO_ROUTES = `import express from "express";

const app = express();

app.get("/weather", (_req, res) => {
  res.json({ weather: "sunny" });
});

app.post("/echo", (req, res) => {
  res.json(req.body);
});
`;

const MULTI_LINE_ROUTES = `import express from "express";
import { paymentLens } from "@x402-lens/express";

const app = express();

const lens = paymentLens({
  routes: {
    "GET /weather": "0.001",
  },
});
app.use(lens.middleware);

app.get("/weather", (_req, res) => res.json({}));

app.post("/echo", (req, res) => res.json(req.body));
`;

describe("adding a second route to an existing lens", () => {
  it("extends the route map instead of claiming the file is already done", async () => {
    const path = await tempFile(TWO_ROUTES);
    await addProtection({ file: path, route: "GET /weather", price: "0.001", write: true });

    const result = await addProtection({
      file: path,
      route: "POST /echo",
      price: "0.005",
      write: true,
    });

    expect(result.changed).toBe(true);
    const updated = await readFile(path, "utf8");
    expect(updated).toContain('"GET /weather": "0.001"');
    expect(updated).toContain('"POST /echo": "0.005"');
    // Still exactly one lens and one mount.
    expect(updated.match(/paymentLens\(/g)).toHaveLength(1);
    expect(updated.match(/app\.use\(lens\.middleware\)/g)).toHaveLength(1);
  });

  it("is idempotent for the route it just added", async () => {
    const path = await tempFile(TWO_ROUTES);
    await addProtection({ file: path, route: "GET /weather", price: "0.001", write: true });
    await addProtection({ file: path, route: "POST /echo", price: "0.005", write: true });
    const afterBoth = await readFile(path, "utf8");

    const third = await addProtection({
      file: path,
      route: "POST /echo",
      price: "0.005",
      write: true,
    });

    expect(third.changed).toBe(false);
    expect(await readFile(path, "utf8")).toBe(afterBoth);
  });

  it("keeps a multi-line route map readable", async () => {
    const path = await tempFile(MULTI_LINE_ROUTES);
    await addProtection({ file: path, route: "POST /echo", price: "0.005", write: true });

    const updated = await readFile(path, "utf8");
    const lines = updated.split("\n");
    const newEntry = lines.find(line => line.includes('"POST /echo"'));
    // Same indentation as the entry above it, not jammed against the brace.
    expect(newEntry).toBe('    "POST /echo": "0.005",');
    expect(lines.filter(line => line.trim() === "},")).toHaveLength(1);
  });

  it("refuses the array form with instructions rather than guessing", async () => {
    const path = await tempFile(`import express from "express";
import { paymentLens } from "@x402-lens/express";

const app = express();
const lens = paymentLens({ routes: [{ route: "GET /weather", price: "0.001" }] });
app.use(lens.middleware);

app.post("/echo", (req, res) => res.json(req.body));
`);

    await expect(
      addProtection({ file: path, route: "POST /echo", price: "0.005", write: true }),
    ).rejects.toThrow(AddError);
  });

  it("does not treat a path mentioned in a comment as an existing price", async () => {
    // The old guard looked for the path anywhere in the file, so a comment
    // mentioning it made the command silently do nothing.
    const path = await tempFile(`import express from "express";
import { paymentLens } from "@x402-lens/express";

// TODO: charge for POST /echo later
const app = express();
const lens = paymentLens({ routes: { "GET /weather": "0.001" } });
app.use(lens.middleware);

app.post("/echo", (req, res) => res.json(req.body));
`);

    const result = await addProtection({
      file: path,
      route: "POST /echo",
      price: "0.005",
      write: true,
    });

    expect(result.changed).toBe(true);
    expect(await readFile(path, "utf8")).toContain('"POST /echo": "0.005"');
  });

  it("does not confuse a prefix route with the exact one", async () => {
    const path = await tempFile(`import express from "express";
import { paymentLens } from "@x402-lens/express";

const app = express();
const lens = paymentLens({ routes: { "GET /weather/history": "0.002" } });
app.use(lens.middleware);

app.get("/weather", (_req, res) => res.json({}));
`);

    const result = await addProtection({
      file: path,
      route: "GET /weather",
      price: "0.001",
      write: true,
    });

    expect(result.changed).toBe(true);
    const updated = await readFile(path, "utf8");
    expect(updated).toContain('"GET /weather/history": "0.002"');
    expect(updated).toContain('"GET /weather": "0.001"');
  });
});
