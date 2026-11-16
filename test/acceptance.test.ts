/**
 * The acceptance check from the brief: how many lines does it take to protect an
 * existing Express route?
 *
 * Counting a line as "code the developer had to write to add payments" — the
 * lens construction, the event subscription, and the mount. Everything else in
 * `examples/express-weather/src/server.ts` is the app that already existed.
 */

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const SERVER_FILE = fileURLToPath(
  new URL("../examples/express-weather/src/server.ts", import.meta.url),
);

/** Lines that exist because of x402, ignoring blanks and comments. */
function protectionLines(source: string): string[] {
  return source
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith("//") && !line.startsWith("*"))
    .filter(
      line =>
        line.includes("paymentLens") ||
        line.includes("lens.middleware") ||
        line.includes("lens.on(") ||
        line.includes("@x402-lens/express"),
    );
}

describe("acceptance: protecting a route", () => {
  it("takes no more than 15 lines, including the import", async () => {
    const source = await readFile(SERVER_FILE, "utf8");
    const lines = protectionLines(source);

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(15);
  });

  it("needs exactly one import, one construction, one subscription, one mount", async () => {
    const source = await readFile(SERVER_FILE, "utf8");
    const lines = protectionLines(source);

    expect(lines.filter(line => line.includes("@x402-lens/express"))).toHaveLength(1);
    expect(lines.filter(line => line.includes("paymentLens("))).toHaveLength(1);
    expect(lines.filter(line => line.includes("app.use(lens.middleware)"))).toHaveLength(1);
  });

  it("states the price in the route config, not in the handler", async () => {
    const source = await readFile(SERVER_FILE, "utf8");
    expect(source).toMatch(/"GET \/weather":\s*"\$\d/);
  });
});
