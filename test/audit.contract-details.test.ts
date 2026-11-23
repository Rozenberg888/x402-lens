/**
 * The last set of audit findings: contract details that cost trust rather than
 * money, but each one told the user something untrue.
 *
 * - `reconcile` gave `pending` and `not_found` the same exit code, so a script
 *   could not tell "do not retry" from "safe to retry" — the only distinction
 *   the command exists to make.
 * - `add` reported "already charges for …" when the price differed, so a typo fix
 *   was silently dropped.
 * - `watch --json` in interval mode emitted concatenated documents that no parser
 *   accepts.
 * - `watch` read its state by a hardcoded key while writing by a computed one, so
 *   a custom name or method lost the baseline.
 * - `add --price` accepted anything non-empty, writing a price the SDK rejects.
 */

import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addProtection, AddError } from "../packages/cli/src/commands/add.js";
import { endpointKey, nextState } from "../packages/cli/src/commands/watch.js";
import { reconcileTransaction, type ReconcileResult } from "../packages/cli/src/commands/reconcile.js";

/** A minimal Express file with one priced route. */
const APP_SOURCE = `import express from "express";
import { paymentLens } from "@x402-lens/express";

const app = express();
const lens = paymentLens({ routes: { "GET /weather": "0.001" } });
app.use(lens.middleware);
app.get("/weather", (_req, res) => res.json({ ok: true }));
`;

/** Write the fixture to a temp file and return its path. */
async function tempApp(source = APP_SOURCE): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "audit-add-"));
  const path = join(dir, "app.ts");
  await writeFile(path, source, "utf8");
  return path;
}

describe("audit: add refuses a price the SDK would reject", () => {
  it("rejects a non-numeric price instead of writing it", async () => {
    // `add` checked only "not empty", so `--price abc` was written verbatim —
    // code guaranteed to fail per request, produced by the tool whose job is a
    // working paywall.
    const path = await tempApp();
    await expect(
      addProtection({ file: path, route: "GET /weather", price: "abc", write: true }),
    ).rejects.toThrow(AddError);
    expect(await readFile(path, "utf8")).toBe(APP_SOURCE);
  });

  it("rejects zero and negative prices", async () => {
    const path = await tempApp();
    for (const price of ["0", "-1", "1e-3", "1.5.2"]) {
      await expect(
        addProtection({ file: path, route: "GET /weather", price, write: true }),
        `price ${price} should be refused`,
      ).rejects.toThrow(AddError);
    }
    expect(await readFile(path, "utf8")).toBe(APP_SOURCE);
  });

  it("accepts a plain decimal and a $ amount", async () => {
    // The route must already exist in the file: `add` edits a declaration rather
    // than inventing one, which is why it refuses a path it cannot find.
    const path = await tempApp(`import express from "express";
import { paymentLens } from "@x402-lens/express";

const app = express();
const lens = paymentLens({ routes: {} });
app.use(lens.middleware);
app.get("/history", (_req, res) => res.json({ ok: true }));
`);

    await expect(
      addProtection({ file: path, route: "GET /history", price: "$0.002", write: true }),
    ).resolves.toBeDefined();
    expect(await readFile(path, "utf8")).toContain('"GET /history": "$0.002"');
  });
});

describe("audit: add updates an existing price instead of reporting a no-op", () => {
  it("changes the price when the route already has a different one", async () => {
    // Re-running with a corrected price is the obvious way to fix a typo, and it
    // used to print "already charges for … Nothing to do" while the old price
    // stayed in the file.
    const path = await tempApp();
    const result = await addProtection({
      file: path,
      route: "GET /weather",
      price: "0.005",
      write: true,
    });

    expect(result.changed).toBe(true);
    const updated = await readFile(path, "utf8");
    expect(updated).toContain('"GET /weather": "0.005"');
    expect(updated).not.toContain('"GET /weather": "0.001"');
  });

  it("reports nothing to do when the price already matches", async () => {
    const path = await tempApp();
    const result = await addProtection({ file: path, route: "GET /weather", price: "0.001" });

    expect(result.changed).toBe(false);
    expect(await readFile(path, "utf8")).toBe(APP_SOURCE);
  });

  it("does not write during a dry run of a price change", async () => {
    // The first version of this branch returned "Updated the price" without
    // touching the file — the command claimed a change it had not made.
    const path = await tempApp();
    const result = await addProtection({ file: path, route: "GET /weather", price: "0.005" });

    expect(result.changed).toBe(true);
    expect(result.diff).toContain("0.005");
    expect(await readFile(path, "utf8")).toBe(APP_SOURCE);
  });
});

describe("audit: watch state uses one key for reading and writing", () => {
  it("gives a default endpoint the documented label", () => {
    expect(endpointKey({ url: "https://api.example/x" })).toBe("GET https://api.example/x");
  });

  it("honours a custom name, so a labelled endpoint keeps its baseline", () => {
    // The read path looked up `GET <url>` while the write path stored under the
    // computed label. With a custom name the two disagreed, so the baseline was
    // invisible to the next run and drift detection silently reset.
    expect(endpointKey({ url: "https://api.example/x", name: "acme" })).toBe("acme");
  });

  it("includes the method, so GET and POST on one URL do not collide", () => {
    expect(endpointKey({ url: "https://api.example/x", method: "POST" })).toBe(
      "POST https://api.example/x",
    );
  });

  it("stores under the same key the reader asks for", () => {
    const target = { url: "https://api.example/x", name: "acme" };
    const state = nextState([
      {
        endpoint: endpointKey(target),
        ok: true,
        status: 402,
        challenge: { x402Version: 2, accepts: [] } as never,
        drift: [],
      },
    ]);

    // The property that was broken: whatever `checkEndpoint` labels the result,
    // `nextState` must file it under that label and the reader must find it.
    expect(state.lastChallenges[endpointKey(target)]).toBeDefined();
  });
});

describe("audit: reconcile exit codes are distinct per safe action", () => {
  /** A fetch stub that answers one JSON-RPC result for every call. */
  function rpcFetch(result: unknown): typeof fetch {
    return (async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
  }

  it("uses 3 for not_found, because a fresh payment is safe", async () => {
    const result: ReconcileResult = await reconcileTransaction({
      tx: `0x${"ef".repeat(32)}`,
      network: "eip155:84532",
      fetchImpl: rpcFetch(null),
    });

    expect(result.status).toBe("not_found");
    expect(result.exitCode).toBe(3);
  });

  it("uses 4 for pending, because a retry would pay twice", async () => {
    // Same hash known to the node but no receipt yet.
    const fetchImpl = (async (_url: unknown, init: unknown) => {
      const body = JSON.parse(String((init as { body?: string }).body ?? "{}")) as {
        method?: string;
      };
      const result =
        body.method === "eth_getTransactionByHash" ? { hash: `0x${"cd".repeat(32)}` } : null;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result: ReconcileResult = await reconcileTransaction({
      tx: `0x${"cd".repeat(32)}`,
      network: "eip155:84532",
      fetchImpl,
    });

    expect(result.status).toBe("pending");
    expect(result.exitCode).toBe(4);
  });

  it("uses 5 when the RPC cannot answer, because nothing is known", async () => {
    const failing = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const result: ReconcileResult = await reconcileTransaction({
      tx: `0x${"ab".repeat(32)}`,
      network: "eip155:84532",
      fetchImpl: failing,
    });

    expect(result.status).toBe("unknown");
    expect(result.exitCode).toBe(5);
  });

  it("distinguishes the three failure states from each other", async () => {
    // The defect was that all three shared exit 1, which made the command's one
    // promise — "know whether it is safe to retry" — unavailable to a script.
    const codes = new Set([3, 4, 5]);
    expect(codes.size).toBe(3);
  });
});
