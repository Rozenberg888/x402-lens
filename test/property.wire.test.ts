/**
 * Property tests: untrusted wire input must never throw unhandled.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  asEvmExactPayload,
  asSvmExactPayload,
  diagnose,
  isAtomicAmount,
  validatePaymentRequired,
  validatePayloadAgainstChallenge,
} from "@x402-lens/core";
import { parseJsonOrBase64, InputError } from "../packages/cli/src/input";

describe("property: wire parsers never throw", () => {
  it("asEvmExactPayload accepts any JSON-like value", () => {
    fc.assert(
      fc.property(fc.jsonValue(), value => {
        expect(() => asEvmExactPayload(value)).not.toThrow();
      }),
      { numRuns: 100 },
    );
  });

  it("asSvmExactPayload accepts any JSON-like value", () => {
    fc.assert(
      fc.property(fc.jsonValue(), value => {
        expect(() => asSvmExactPayload(value)).not.toThrow();
      }),
      { numRuns: 100 },
    );
  });

  it("diagnose accepts arbitrary partial exchanges", () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.jsonValue(), fc.jsonValue(), (a, b, c) => {
        expect(() =>
          diagnose({
            paymentRequired: a as never,
            paymentPayload: b as never,
            verifyResponse: c as never,
          }),
        ).not.toThrow();
      }),
      { numRuns: 80 },
    );
  });

  it("validatePaymentRequired never throws on junk", () => {
    fc.assert(
      fc.property(fc.jsonValue(), value => {
        expect(() => validatePaymentRequired(value as never)).not.toThrow();
      }),
      { numRuns: 80 },
    );
  });

  it("validatePayloadAgainstChallenge never throws on junk pairs", () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.jsonValue(), (payload, challenge) => {
        expect(() =>
          validatePayloadAgainstChallenge(payload as never, challenge as never),
        ).not.toThrow();
      }),
      { numRuns: 80 },
    );
  });

  it("isAtomicAmount is true only for digit strings", () => {
    fc.assert(
      fc.property(fc.string(), value => {
        const ok = isAtomicAmount(value);
        expect(ok).toBe(/^\d+$/.test(value));
      }),
      { numRuns: 100 },
    );
  });
});

describe("property: parseJsonOrBase64", () => {
  it("never throws anything other than InputError", () => {
    fc.assert(
      fc.property(fc.string(), value => {
        try {
          parseJsonOrBase64(value, "input");
        } catch (error) {
          expect(error).toBeInstanceOf(InputError);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("round-trips arbitrary JSON objects through base64", () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string(), fc.jsonValue()),
        obj => {
          const encoded = Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
          expect(parseJsonOrBase64(encoded, "input")).toEqual(obj);
        },
      ),
      { numRuns: 50 },
    );
  });
});
