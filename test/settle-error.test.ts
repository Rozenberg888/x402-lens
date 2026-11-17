/**
 * Unit coverage for recovering settle bodies from onSettleFailure errors.
 *
 * Argus Lab (seal 0023) observed payment.settle_failed with findings: [] because
 * SettleError carries fields on the error itself, not under settleResponse.
 */

import { describe, expect, it } from "vitest";
import { diagnose, settleResponseFromError } from "@x402-lens/core";

describe("settleResponseFromError", () => {
  it("returns undefined for non-objects and plain Errors", () => {
    expect(settleResponseFromError(undefined)).toBeUndefined();
    expect(settleResponseFromError(null)).toBeUndefined();
    expect(settleResponseFromError("boom")).toBeUndefined();
    expect(settleResponseFromError(new Error("plain"))).toBeUndefined();
  });

  it("unwraps nested settleResponse / result / body", () => {
    const body = {
      success: false,
      errorReason: "insufficient_funds",
      transaction: "0xabc",
      network: "eip155:84532",
      payer: "0xpayer",
    };

    expect(settleResponseFromError({ settleResponse: body })).toEqual(body);
    expect(settleResponseFromError({ result: body })).toEqual(body);
    expect(settleResponseFromError({ body })).toEqual(body);
  });

  it("synthesises success:false from SettleError-shaped fields", () => {
    const error = {
      name: "SettleError",
      message: "insufficient_funds",
      errorReason: "insufficient_funds",
      errorMessage: "wallet underfunded",
      payer: "0xpayer",
      transaction: "0xtx",
      network: "eip155:84532",
      statusCode: 500,
    };

    expect(settleResponseFromError(error)).toEqual({
      success: false,
      errorReason: "insufficient_funds",
      errorMessage: "wallet underfunded",
      payer: "0xpayer",
      transaction: "0xtx",
      network: "eip155:84532",
    });
  });

  it("accepts duck-typed errors that only carry errorReason", () => {
    expect(settleResponseFromError({ errorReason: "settlement_pending" })).toEqual({
      success: false,
      errorReason: "settlement_pending",
    });
  });

  it("prefers nested settleResponse over top-level SettleError fields", () => {
    const nested = {
      success: false,
      errorReason: "from_nested",
      transaction: "0xnested",
    };
    expect(
      settleResponseFromError({
        name: "SettleError",
        errorReason: "from_error",
        settleResponse: nested,
      }),
    ).toEqual(nested);
  });

  it("feeds diagnose with settlement_failed findings (Argus gap)", () => {
    const settle = settleResponseFromError({
      name: "SettleError",
      errorReason: "insufficient_funds",
      transaction: "",
      network: "eip155:84532",
    });
    expect(settle).toBeDefined();
    const findings = diagnose({ settleResponse: settle });
    expect(findings.map(f => f.code)).toContain("settlement_failed");
  });

  it("feeds diagnose with settlement_pending findings", () => {
    const settle = settleResponseFromError({
      name: "SettleError",
      errorReason: "settlement_pending",
      transaction: `0x${"22".repeat(32)}`,
      network: "eip155:84532",
    });
    const findings = diagnose({ settleResponse: settle });
    expect(findings.map(f => f.code)).toContain("settlement_pending");
  });
});
