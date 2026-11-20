/**
 * Synthetic monitoring: what counts as a regression.
 *
 * The interesting behaviour is not "does it return 402". A paywall can keep
 * returning 402 while becoming unusable for everyone who was paying: a network
 * disappears from `accepts`, the recipient changes, CORS is lost. An uptime
 * check calls all of those healthy.
 *
 * Every comparison here is about that: would a client that paid successfully
 * before still be able to pay now?
 */

import { describe, expect, it } from "vitest";
import type { WirePaymentRequired } from "@x402-lens/core";
import { diffChallenges, nextState, readWatchState, writeWatchState } from "../packages/cli/src/commands/watch.js";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NETWORK = "eip155:84532";
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

function challenge(
  overrides: Partial<{ network: string; payTo: string; asset: string; amount: string; scheme: string }> = {},
  extra: Array<Partial<{ network: string; payTo: string; asset: string; amount: string; scheme: string }>> = [],
): WirePaymentRequired {
  const base = {
    scheme: "exact",
    network: NETWORK,
    payTo: PAY_TO,
    asset: ASSET,
    amount: "1000",
    maxTimeoutSeconds: 60,
    ...overrides,
  };

  return {
    x402Version: 2,
    accepts: [base, ...extra.map(entry => ({ ...base, ...entry }))],
  } as unknown as WirePaymentRequired;
}

describe("diffChallenges: no baseline", () => {
  it("reports nothing on the first check", () => {
    // A monitor installed today must not page about yesterday's configuration.
    expect(diffChallenges("api", undefined, challenge())).toEqual([]);
  });
});

describe("diffChallenges: paywall disappears", () => {
  it("reports paywall_gone when a challenge stops being returned", () => {
    const drift = diffChallenges("api", challenge(), undefined);
    expect(drift).toHaveLength(1);
    expect(drift[0]?.kind).toBe("paywall_gone");
  });

  it("names the endpoint so an alert is actionable", () => {
    const drift = diffChallenges("POST https://api.example/run", challenge(), undefined);
    expect(drift[0]?.endpoint).toBe("POST https://api.example/run");
  });

  it("says what breaks, not just that something changed", () => {
    const drift = diffChallenges("api", challenge(), undefined);
    expect(drift[0]?.detail).toMatch(/no longer returns an x402 challenge/);
  });
});

describe("diffChallenges: payment options", () => {
  it("reports a removed network, because clients on it start failing", () => {
    const before = challenge({}, [{ network: "eip155:8453" }]);
    const after = challenge();

    const drift = diffChallenges("api", before, after);
    const removed = drift.find(item => item.kind === "network_removed");
    expect(removed).toBeDefined();
    expect(removed?.detail).toContain("eip155:8453");
  });

  it("reports an added network without calling it a regression", () => {
    const before = challenge();
    const after = challenge({}, [{ network: "eip155:8453" }]);

    const drift = diffChallenges("api", before, after);
    expect(drift.some(item => item.kind === "network_added")).toBe(true);
    // Adding an option breaks nobody, so it must not be reported as removal.
    expect(drift.some(item => item.kind === "network_removed")).toBe(false);
  });

  it("reports payTo changing, because that redirects money", () => {
    const before = challenge();
    const after = challenge({ payTo: "0x0000000000000000000000000000000000000001" });

    const drift = diffChallenges("api", before, after);
    const changed = drift.find(item => item.kind === "pay_to_changed");
    expect(changed).toBeDefined();
    // Both values are valid addresses; only the comparison reveals the change.
    expect(changed?.detail).toContain(PAY_TO);
  });

  it("reports the asset changing", () => {
    const before = challenge();
    const after = challenge({ asset: "0x0000000000000000000000000000000000000002" });

    expect(diffChallenges("api", before, after).some(item => item.kind === "asset_changed")).toBe(true);
  });

  it("reports a price change in atomic units", () => {
    const before = challenge({ amount: "1000" });
    const after = challenge({ amount: "2000" });

    const drift = diffChallenges("api", before, after);
    const price = drift.find(item => item.kind === "amount_increased");
    expect(price).toBeDefined();
    expect(price?.detail).toContain("1000");
    expect(price?.detail).toContain("2000");
  });

  it("reports nothing when the challenge is unchanged", () => {
    // The healthy case must be silent, or the monitor becomes noise and gets
    // ignored before the day it matters.
    expect(diffChallenges("api", challenge(), challenge())).toEqual([]);
  });
});

describe("diffChallenges: option order", () => {
  it("reports scheme_changed when the primary offer moves", () => {
    const before = challenge({}, [{ network: "eip155:8453" }]);
    // Same two options, reversed: a client reading accepts[0] now pays with a
    // different network than before.
    const after = {
      x402Version: 2,
      accepts: [...(before.accepts ?? [])].reverse(),
    } as unknown as WirePaymentRequired;

    const drift = diffChallenges("api", before, after);
    expect(drift.some(item => item.kind === "scheme_changed")).toBe(true);
  });
});

describe("nextState", () => {
  it("records challenges for endpoints that returned one", () => {
    const state = nextState([
      { endpoint: "a", ok: true, status: 402, challenge: challenge(), drift: [] },
    ]);

    expect(state.lastChallenges.a).toBeDefined();
  });

  it("keeps the previous baseline when a check failed", () => {
    const previous = { lastChallenges: { a: challenge() } };
    const state = nextState(
      [{ endpoint: "a", ok: false, status: 0, drift: [], error: "ECONNREFUSED" }],
      previous,
    );

    // Losing the baseline on a network blip would make the next successful
    // check look like a fresh install, hiding any regression that happened
    // during the outage.
    expect(state.lastChallenges.a).toBeDefined();
  });

  it("preserves endpoints not checked in this run", () => {
    const previous = { lastChallenges: { a: challenge(), b: challenge() } };
    const state = nextState([{ endpoint: "a", ok: true, status: 402, challenge: challenge(), drift: [] }], previous);

    expect(Object.keys(state.lastChallenges).sort()).toEqual(["a", "b"]);
  });
});

describe("watch state persistence", () => {
  it("returns empty state for a missing file", async () => {
    const missing = join(await mkdtemp(join(tmpdir(), "watch-")), "nope.json");
    await expect(readWatchState(missing)).resolves.toEqual({ lastChallenges: {} });
  });

  it("returns empty state for a corrupt file instead of throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "watch-"));
    const path = join(dir, "state.json");
    await writeFile(path, "{ this is not json", "utf8");

    // A corrupted monitor state must not take the monitor down.
    await expect(readWatchState(path)).resolves.toEqual({ lastChallenges: {} });
  });

  it("round-trips through disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "watch-"));
    const path = join(dir, "state.json");
    const state = { lastChallenges: { a: challenge() } };

    await writeWatchState(path, state);
    await expect(readWatchState(path)).resolves.toEqual(state);
  });

  it("writes valid JSON with a trailing newline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "watch-"));
    const path = join(dir, "state.json");

    await writeWatchState(path, { lastChallenges: {} });

    const raw = await readFile(path, "utf8");
    // A digest or config-management tool may diff this file.
    expect(raw.endsWith("\n")).toBe(true);
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("leaves no temporary file behind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "watch-"));
    const path = join(dir, "state.json");

    await writeWatchState(path, { lastChallenges: {} });

    // The write goes through a temp file to stay atomic; leaving it behind
    // would accumulate one per run.
    const entries = await readdir(dir);
    expect(entries).toEqual(["state.json"]);
  });
});
