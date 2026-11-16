/**
 * Boundary tests for the wire-level guards.
 *
 * These exist because mutation testing showed the original suite only exercised
 * the happy path through each predicate. Every assertion below is tied to one
 * surviving mutant: removing the `$` anchor, inverting a null check, or
 * loosening a length bound would leave the previous suite green, and a validator
 * that accepts malformed input is how an unpayable challenge reaches production.
 */

import { describe, expect, it } from "vitest";
import {
  asEvmExactPayload,
  asSvmExactPayload,
  isAtomicAmount,
  isCaip2Network,
  isSolanaAddress,
  isSvmExactPayload,
} from "@x402-lens/core";

describe("isAtomicAmount", () => {
  it("accepts an integer string", () => {
    expect(isAtomicAmount("10000")).toBe(true);
    expect(isAtomicAmount("0")).toBe(true);
  });

  it("rejects an empty string", () => {
    // Length-zero is checked before the regex; without that check `""` would be
    // rejected by the regex anyway, but the guard is what stops a mutant that
    // returns true early.
    expect(isAtomicAmount("")).toBe(false);
  });

  it("rejects a decimal point or comma anywhere", () => {
    expect(isAtomicAmount("0.01")).toBe(false);
    expect(isAtomicAmount("100.0")).toBe(false);
    expect(isAtomicAmount("1,5")).toBe(false);
  });

  it("rejects leading or trailing whitespace and signs", () => {
    expect(isAtomicAmount(" 100")).toBe(false);
    expect(isAtomicAmount("100 ")).toBe(false);
    expect(isAtomicAmount("-100")).toBe(false);
    expect(isAtomicAmount("+100")).toBe(false);
  });

  it("rejects a value with trailing garbage", () => {
    // Kills a mutant that drops the `$` anchor: "100abc" would then match.
    expect(isAtomicAmount("100abc")).toBe(false);
    expect(isAtomicAmount("100\n")).toBe(false);
  });

  it("rejects a value with leading garbage", () => {
    // Kills a mutant that drops the `^` anchor.
    expect(isAtomicAmount("abc100")).toBe(false);
    expect(isAtomicAmount("\n100")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isAtomicAmount(100)).toBe(false);
    expect(isAtomicAmount(null)).toBe(false);
    expect(isAtomicAmount(undefined)).toBe(false);
    expect(isAtomicAmount(["100"])).toBe(false);
  });
});

describe("isCaip2Network", () => {
  it("accepts a namespace and reference", () => {
    expect(isCaip2Network("eip155:84532")).toBe(true);
    expect(isCaip2Network("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1")).toBe(true);
  });

  it("rejects a shorthand without a colon", () => {
    expect(isCaip2Network("base-sepolia")).toBe(false);
  });

  it("rejects a reference with trailing garbage", () => {
    // Kills the mutant that drops the `$` anchor.
    expect(isCaip2Network("eip155:84532 extra")).toBe(false);
    expect(isCaip2Network("eip155:84532\n")).toBe(false);
  });

  it("rejects leading garbage before the namespace", () => {
    expect(isCaip2Network(" eip155:84532")).toBe(false);
  });

  it("rejects an uppercase namespace, since CAIP-2 requires lowercase", () => {
    expect(isCaip2Network("EIP155:84532")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isCaip2Network(155)).toBe(false);
    expect(isCaip2Network(null)).toBe(false);
  });
});

describe("isSolanaAddress", () => {
  const VALID = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

  it("accepts a base58 address", () => {
    expect(isSolanaAddress(VALID)).toBe(true);
  });

  it("rejects trailing garbage", () => {
    // Kills the mutant that drops the `$` anchor. This is the exact gap mutation
    // testing found: a 45+ character string would have been accepted.
    expect(isSolanaAddress(`${VALID}!`)).toBe(false);
    expect(isSolanaAddress(`${VALID} `)).toBe(false);
  });

  it("rejects an EVM address", () => {
    expect(isSolanaAddress("0x209693Bc6afc0C5328bA36FaF03C514EF312287C")).toBe(false);
  });

  it("rejects characters outside the base58 alphabet", () => {
    // `0`, `O`, `I`, and `l` are excluded to avoid visual ambiguity.
    expect(isSolanaAddress("0".repeat(44))).toBe(false);
    expect(isSolanaAddress("O".repeat(44))).toBe(false);
    expect(isSolanaAddress("I".repeat(44))).toBe(false);
    expect(isSolanaAddress("l".repeat(44))).toBe(false);
  });

  it("rejects a too-short or too-long value", () => {
    expect(isSolanaAddress("abc")).toBe(false);
    expect(isSolanaAddress("9".repeat(31))).toBe(false);
    expect(isSolanaAddress("9".repeat(45))).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isSolanaAddress(null)).toBe(false);
    expect(isSolanaAddress({})).toBe(false);
  });
});

describe("asEvmExactPayload", () => {
  const valid = {
    payload: {
      signature: `0x${"ab".repeat(65)}`,
      authorization: {
        from: "0x857b06519E91e3A54538791bDAbd0E22373e36b66",
        to: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
        value: "10000",
        validAfter: "0",
        validBefore: "9999999999",
        nonce: `0x${"cd".repeat(32)}`,
      },
    },
  };

  it("extracts a well-formed payload", () => {
    expect(asEvmExactPayload(valid)?.authorization.value).toBe("10000");
  });

  it("returns undefined for a non-object", () => {
    // Each of these kills a mutant that turns the guard into `&&` or removes it.
    expect(asEvmExactPayload(null)).toBeUndefined();
    expect(asEvmExactPayload(undefined)).toBeUndefined();
    expect(asEvmExactPayload("payload")).toBeUndefined();
    expect(asEvmExactPayload(42)).toBeUndefined();
  });

  it("returns undefined when payload is not an object", () => {
    expect(asEvmExactPayload({ payload: null })).toBeUndefined();
    expect(asEvmExactPayload({ payload: "x" })).toBeUndefined();
    expect(asEvmExactPayload({ payload: undefined })).toBeUndefined();
    expect(asEvmExactPayload({})).toBeUndefined();
  });

  it("returns undefined without a string signature", () => {
    expect(asEvmExactPayload({ payload: { authorization: valid.payload.authorization } })).toBeUndefined();
    expect(
      asEvmExactPayload({
        payload: { signature: 42, authorization: valid.payload.authorization },
      }),
    ).toBeUndefined();
  });

  it("returns undefined when the authorization is not an object", () => {
    expect(asEvmExactPayload({ payload: { signature: "0xab", authorization: null } })).toBeUndefined();
    expect(asEvmExactPayload({ payload: { signature: "0xab", authorization: "x" } })).toBeUndefined();
  });

  it("returns undefined unless both from and to are strings", () => {
    const base = { signature: "0xab", authorization: { ...valid.payload.authorization } };
    expect(
      asEvmExactPayload({ payload: { ...base, authorization: { ...base.authorization, from: 1 } } }),
    ).toBeUndefined();
    expect(
      asEvmExactPayload({ payload: { ...base, authorization: { ...base.authorization, to: 1 } } }),
    ).toBeUndefined();
  });

  it("returns undefined without a string value", () => {
    const base = { signature: "0xab", authorization: { ...valid.payload.authorization } };
    expect(
      asEvmExactPayload({ payload: { ...base, authorization: { ...base.authorization, value: 100 } } }),
    ).toBeUndefined();
  });
});

describe("asSvmExactPayload", () => {
  it("extracts a base64 transaction", () => {
    expect(asSvmExactPayload({ payload: { transaction: "AQABAg==" } })?.transaction).toBe("AQABAg==");
  });

  it("rejects an empty transaction", () => {
    // An empty string is present but carries no transaction, so treating it as a
    // Solana payment would skip the EVM rules for no reason.
    expect(asSvmExactPayload({ payload: { transaction: "" } })).toBeUndefined();
  });

  it("rejects a payload with no transaction", () => {
    expect(asSvmExactPayload({ payload: {} })).toBeUndefined();
    expect(asSvmExactPayload({ payload: { signature: "0xab" } })).toBeUndefined();
  });

  it("rejects non-objects", () => {
    expect(asSvmExactPayload(null)).toBeUndefined();
    expect(asSvmExactPayload("x")).toBeUndefined();
    expect(asSvmExactPayload({ payload: null })).toBeUndefined();
  });

  it("is not confused with an EVM payload", () => {
    const evm = { payload: { signature: "0xab", authorization: { from: "0xa", to: "0xb", value: "1" } } };
    expect(isSvmExactPayload(evm)).toBe(false);
    expect(isSvmExactPayload({ payload: { transaction: "AQAB" } })).toBe(true);
  });
});
