/**
 * `explain` must refuse an argument that is not the thing it names.
 *
 * `readJsonArgument` accepts any JSON value, and `explain` cast the result to a
 * wire type. `--challenge '[]'` therefore counted as a challenge — the header
 * printed "challenge: yes" — and the report blamed the server for having no
 * `accepts[]`, advising "Configure at least one route with a price, network, and
 * payTo". Advice about a server that was never described is worse than an error:
 * it sends the reader to their config for a mistake they made in the command.
 *
 * A wrong argument is a usage error, so it exits 2 as `InputError` does
 * everywhere else, rather than 1, which means "the exchange has findings".
 */

import { describe, expect, it } from "vitest";
import { explainPayment } from "../packages/cli/src/commands/explain.js";
import { InputError } from "../packages/cli/src/input.js";

describe("explain: non-object arguments", () => {
  it("refuses an array for --challenge", async () => {
    await expect(explainPayment({ challenge: "[]" })).rejects.toThrow(InputError);
    await expect(explainPayment({ challenge: "[]" })).rejects.toThrow(
      /--challenge must be a JSON object .* but it is an array/,
    );
  });

  it("refuses null for --challenge", async () => {
    await expect(explainPayment({ challenge: "null" })).rejects.toThrow(InputError);
  });

  it("refuses a bare number for --payment", async () => {
    await expect(explainPayment({ payment: "42" })).rejects.toThrow(InputError);
    // `42` *is* valid JSON, so the message must not claim it is not. The reader
    // who pasted a number needs to know a number is the wrong kind of value.
    await expect(explainPayment({ payment: "42" })).rejects.toThrow(/valid JSON but is not an object/);
  });

  it("names the argument that is wrong, not just that something is", async () => {
    // With four arguments an unnamed error leaves the reader guessing which one.
    await expect(explainPayment({ settle: "[]" })).rejects.toThrow(/--settle/);
  });

  it("still accepts an object", async () => {
    const result = await explainPayment({ challenge: '{"x402Version":2,"accepts":[]}' });
    // The object is a real (if incomplete) challenge, so it is diagnosed, not
    // rejected: exit 1 for findings, and the header reflects what was supplied.
    expect(result.exitCode).toBe(1);
    expect(result.text).toContain("challenge: yes");
    expect(result.findings.some(finding => finding.code === "missing_accepts")).toBe(true);
  });
});
