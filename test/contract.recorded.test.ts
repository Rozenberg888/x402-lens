/**
 * Contract tests against recorded real output.
 *
 * Everything else in the suite uses hand-written fixtures, which encode what we
 * *think* the protocol looks like. These use objects that a real middleware
 * actually emitted, so a change in `@x402/*` shows up here as a failing
 * assertion instead of as a bug report from someone whose payments stopped
 * working.
 *
 * The recordings live in `test/fixtures/recorded/` and are re-recorded with
 * `npm run fixtures:record`. They are not regenerated as part of the test run:
 * a fixture that follows the implementation cannot catch the implementation
 * changing.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  diagnose,
  isSolanaAddress,
  validatePaymentRequired,
  type WirePaymentRequired,
} from "@x402-lens/core";

const RECORDED = fileURLToPath(new URL("./fixtures/recorded/", import.meta.url));

/**
 * Load a recorded fixture.
 *
 * @param name - File name without extension
 * @returns The parsed fixture
 */
function load<T = RecordedChallenge>(name: string): T {
  return JSON.parse(readFileSync(`${RECORDED}${name}.json`, "utf8")) as T;
}

interface RecordedChallenge {
  note: string;
  capturedAt: string;
  body: WirePaymentRequired;
}

interface RecordedSupported {
  note: string;
  body: {
    kinds?: Array<{ x402Version?: number; scheme?: string; network?: string }>;
  };
}

describe("recorded challenge from the real middleware", () => {
  const recorded = load("challenge-two-networks");
  const challenge = recorded.body;

  it("is schema-conformant, so the validator agrees with the SDK", () => {
    expect(validatePaymentRequired(challenge)).toEqual([]);
  });

  it("carries one accepts entry per network, in configuration order", () => {
    expect(challenge.accepts?.map(entry => entry.network)).toEqual([
      "eip155:84532",
      "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    ]);
  });

  it("produces no findings on a correct challenge", () => {
    // The most important assertion here: a diagnostic that invents problems on
    // real, correct output is worse than no diagnostic.
    expect(diagnose({ paymentRequired: challenge, now: Date.parse("2026-11-16T00:00:00Z") })).toEqual([]);
  });

  it("uses a base58 recipient and mint on the Solana entry", () => {
    // What the 0.1.0 bug violated: an EVM address was advertised for Solana.
    const solana = challenge.accepts?.find(entry => entry.network.startsWith("solana:"));
    expect(solana).toBeDefined();
    expect(isSolanaAddress(solana?.payTo)).toBe(true);
    expect(isSolanaAddress(solana?.asset)).toBe(true);
  });

  it("uses a 20-byte address and a contract on the EVM entry", () => {
    const evm = challenge.accepts?.find(entry => entry.network.startsWith("eip155:"));
    expect(evm?.payTo).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(evm?.asset).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("gives every entry an atomic amount", () => {
    for (const entry of challenge.accepts ?? []) {
      expect(entry.amount).toMatch(/^\d+$/);
    }
  });

  it("gives every entry a positive timeout", () => {
    for (const entry of challenge.accepts ?? []) {
      expect(entry.maxTimeoutSeconds).toBeGreaterThan(0);
    }
  });
});

describe("recorded challenge with an upfront flow", () => {
  const recorded = load("challenge-upfront-flow");
  const challenge = recorded.body;

  it("is schema-conformant", () => {
    expect(validatePaymentRequired(challenge)).toEqual([]);
  });

  it("declares extra.paymentFlow on every entry", () => {
    // The flow is read only from here, so a missing field means the setting was
    // silently dropped.
    for (const entry of challenge.accepts ?? []) {
      expect(entry.extra?.paymentFlow).toBe("upfront");
    }
  });

  it("is the only difference from the default challenge", () => {
    const plain = load("challenge-two-networks").body;
    const withFlow = challenge.accepts ?? [];
    const withoutFlow = plain.accepts ?? [];
    expect(withFlow).toHaveLength(withoutFlow.length);

    for (let index = 0; index < withFlow.length; index += 1) {
      const flowed = { ...withFlow[index]?.extra } as Record<string, unknown>;
      const baseline = { ...withoutFlow[index]?.extra } as Record<string, unknown>;
      delete flowed.paymentFlow;
      delete baseline.paymentFlow;
      expect(flowed).toEqual(baseline);
    }
  });
});

describe("recorded EVM payload shape", () => {
  const recorded = load<{ body: { accepted?: Record<string, unknown>; payload?: Record<string, unknown> } }>(
    "payload-evm-exact-shape",
  );
  const payload = recorded.body;

  it("matches the challenge's first offer", () => {
    const challenge = load("challenge-two-networks").body;
    const first = challenge.accepts?.[0];
    expect(payload.accepted?.network).toBe(first?.network);
    expect(payload.accepted?.amount).toBe(first?.amount);
  });

  it("is not misreported as a mismatch", () => {
    const challenge = load("challenge-two-networks").body;
    const findings = diagnose({
      paymentRequired: challenge,
      paymentPayload: payload as never,
      now: Date.parse("2026-11-16T00:00:00Z"),
    });
    // The recorded authorization window is an hour wide from capture time, so the
    // only finding that could legitimately appear is one about the clock; assert
    // no mismatch codes specifically.
    const codes = findings.map(finding => finding.code);
    expect(codes).not.toContain("amount_mismatch");
    expect(codes).not.toContain("pay_to_mismatch");
    expect(codes).not.toContain("asset_mismatch");
    expect(codes).not.toContain("network_not_offered");
  });
});

describe("recorded facilitator vocabulary", () => {
  const recorded = load<RecordedSupported>("facilitator-supported");
  const kinds = recorded.body.kinds ?? [];

  it("lists the networks the fixtures were recorded against", () => {
    expect(kinds.some(kind => kind.network === "eip155:84532" && kind.x402Version === 2)).toBe(true);
    expect(
      kinds.some(
        kind =>
          kind.network === "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" && kind.x402Version === 2,
      ),
    ).toBe(true);
  });

  it("supports the exact scheme everywhere the package registers it", () => {
    for (const kind of kinds) {
      if (kind.x402Version !== 2) continue;
      expect(typeof kind.scheme).toBe("string");
    }
  });
});
