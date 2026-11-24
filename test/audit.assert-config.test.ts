/**
 * `assertLensConfig` validates a hand-built config, and did not validate what
 * `resolveConfig` had learned to refuse.
 *
 * The function is documented as "still validates" for a pre-built `LensConfig`,
 * which is the documented way to skip file/env loading. Every check added to
 * `resolveConfig` — timeouts, network consistency, route methods — was absent
 * here, so that path bypassed all of them:
 *
 *   maxTimeoutSeconds: -1        accepted, advertised on the wire
 *   facilitatorTimeoutMs: 5e9    accepted, RangeError in the SDK constructor
 *   network ≠ networks[0]        accepted, challenge and events disagree
 *   payToByNetwork with extra    accepted, a chain looks for sale that is not
 *   POX /weather                 accepted, route never matches
 *
 * A validator that covers most fields is worse than none for the fields it
 * misses: the operator sees "assertLensConfig" in the docs and assumes the list
 * is complete.
 */

import { describe, expect, it } from "vitest";
import { assertLensConfig, ConfigError, resolveConfig, type LensConfig } from "@x402-lens/core";

const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const EVM = "eip155:84532";
const SVM = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const SVM_PAY_TO = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

/** A config built the normal way, then mutated for a case. */
function baseline(): LensConfig {
  return resolveConfig({
    facilitatorUrl: "https://facilitator.example.com",
    network: EVM,
    payTo: PAY_TO,
    routes: { "GET /weather": "0.001" },
  });
}

describe("assertLensConfig: timeouts", () => {
  it("rejects a non-positive maxTimeoutSeconds", () => {
    // Advertised on the wire as-is; conformant clients refuse to sign against a
    // negative or zero window, so the buyer sees an unexplained failure.
    for (const value of [-1, 0, 0.5, Number.NaN]) {
      expect(
        () => assertLensConfig({ ...baseline(), maxTimeoutSeconds: value }),
        `maxTimeoutSeconds ${String(value)} should be refused`,
      ).toThrow(ConfigError);
    }
  });

  it("rejects a facilitatorTimeoutMs above the platform ceiling", () => {
    // Accepted here, then `RangeError` from the SDK constructor — an uncaught
    // startup crash with no field name in it.
    expect(() => assertLensConfig({ ...baseline(), facilitatorTimeoutMs: 5_000_000_000 })).toThrow(
      /at most 2147483647/,
    );
  });

  it("rejects a non-positive facilitatorTimeoutMs", () => {
    for (const value of [0, -1, 1.5]) {
      expect(
        () => assertLensConfig({ ...baseline(), facilitatorTimeoutMs: value }),
        `facilitatorTimeoutMs ${String(value)} should be refused`,
      ).toThrow(ConfigError);
    }
  });

  it("accepts the values resolveConfig itself produces", () => {
    expect(() => assertLensConfig(baseline())).not.toThrow();
  });
});

describe("assertLensConfig: network consistency", () => {
  it("rejects a network that is not networks[0]", () => {
    // The challenge advertises `networks`; events and every default read
    // `network`. A disagreement means the server sells one chain and reports
    // another.
    expect(() => assertLensConfig({ ...baseline(), network: "eip155:1" })).toThrow(/must agree/);
  });

  it("rejects a payToByNetwork entry for a network that is not advertised", () => {
    // The Solana address would never be used while the operator believes that
    // chain is for sale — measured before this check: an EVM-only deployment
    // with a Solana address in the map was accepted.
    const config = baseline();
    expect(() =>
      assertLensConfig({ ...config, payToByNetwork: { ...config.payToByNetwork, [SVM]: SVM_PAY_TO } }),
    ).toThrow(/never advertised/);
  });

  it("allows the wildcard entry, which is not a network", () => {
    const config = baseline();
    expect(() =>
      assertLensConfig({
        ...config,
        payToByNetwork: { ...config.payToByNetwork, "*": PAY_TO },
      }),
    ).not.toThrow();
  });
});

/** The first route, which every fixture has. */
function firstRoute(config: LensConfig) {
  const route = config.routes[0];
  if (!route) throw new Error("fixture has no routes");
  return route;
}

describe("assertLensConfig: route methods", () => {
  it("rejects a method that is not an HTTP method", () => {
    const config = baseline();
    const broken = { ...firstRoute(config), method: "POX" };
    expect(() => assertLensConfig({ ...config, routes: [broken] })).toThrow(/not an HTTP method/);
  });

  it("normalises a lowercase method so it can still match", () => {
    // Validating without normalising would leave `get` in the route table, which
    // never matches a `GET` request — the same silent-unprotected outcome the
    // check exists to prevent.
    const config = baseline();
    const lower = { ...firstRoute(config), method: "get" };
    const mutable = { ...config, routes: [lower] } as LensConfig;
    expect(() => assertLensConfig(mutable)).not.toThrow();
    expect(mutable.routes[0]?.method).toBe("GET");
  });

  it("still accepts the wildcard method", () => {
    const config = baseline();
    expect(() =>
      assertLensConfig({ ...config, routes: [{ ...firstRoute(config), method: "*" }] }),
    ).not.toThrow();
  });
});
