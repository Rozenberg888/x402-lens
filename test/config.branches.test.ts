/**
 * Branch-level tests for configuration resolution.
 *
 * Written after mutation testing reported 65% on `config.ts`: the original suite
 * checked that valid input produced valid output and that invalid input threw,
 * but not *which* branch threw. A mutant that swapped one error message for
 * another, or that dropped the `trim()` before comparing addresses, survived.
 *
 * On a payment path a wrong branch is a wrong amount or a wrong recipient, so
 * these assert the specific field and the specific reason.
 */

import { describe, expect, it } from "vitest";
import {
  assertLensConfig,
  ConfigError,
  resolveConfig,
  toRoutesConfig,
  type LensConfig,
} from "@x402-lens/core";

const EVM = "eip155:84532";
const EVM_MAINNET = "eip155:8453";
const SVM = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const ADDRESS = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const SOL_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

/** Minimal valid input, overridden per test. */
function input(overrides: Record<string, unknown> = {}) {
  return {
    facilitatorUrl: "https://x402.org/facilitator",
    network: EVM,
    payTo: ADDRESS,
    routes: [{ route: "GET /weather", price: "0.001" }],
    env: {} as Record<string, string | undefined>,
    ...overrides,
  };
}

/** Assert that a call throws a ConfigError on `field`. */
function expectConfigError(fn: () => unknown, field: string): ConfigError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).field).toBe(field);
    return error as ConfigError;
  }
  throw new Error(`expected a ConfigError on ${field}, nothing was thrown`);
}

describe("required fields name the exact field", () => {
  it("blames facilitatorUrl", () => {
    expectConfigError(() => resolveConfig(input({ facilitatorUrl: undefined })), "facilitatorUrl");
  });

  it("blames network", () => {
    expectConfigError(() => resolveConfig(input({ network: undefined })), "network");
  });

  it("blames payTo", () => {
    expectConfigError(() => resolveConfig(input({ payTo: undefined })), "payTo");
  });

  it("blames routes", () => {
    expectConfigError(() => resolveConfig(input({ routes: [] })), "routes");
  });
});

describe("facilitator URL", () => {
  it("rejects a URL with no scheme", () => {
    expectConfigError(() => resolveConfig(input({ facilitatorUrl: "x402.org/facilitator" })), "facilitatorUrl");
  });

  it("rejects a non-http scheme", () => {
    const error = expectConfigError(
      () => resolveConfig(input({ facilitatorUrl: "ws://x402.org/facilitator" })),
      "facilitatorUrl",
    );
    expect(error.message).toContain("http(s)");
  });

  it("accepts http as well as https, for local facilitators", () => {
    expect(resolveConfig(input({ facilitatorUrl: "http://127.0.0.1:3000" })).facilitatorUrl).toBe(
      "http://127.0.0.1:3000",
    );
  });

  it("strips every trailing slash", () => {
    expect(resolveConfig(input({ facilitatorUrl: "https://x402.org/facilitator///" })).facilitatorUrl).toBe(
      "https://x402.org/facilitator",
    );
  });
});

describe("network list", () => {
  it("blames network for an unparseable id", () => {
    expectConfigError(() => resolveConfig(input({ network: "not-a-network" })), "network");
  });

  it("suggests a CAIP-2 id for a known shorthand", () => {
    const error = expectConfigError(() => resolveConfig(input({ network: "base-sepolia" })), "network");
    expect(error.message).toContain("eip155:84532");
  });

  it("falls back to a generic example when the shorthand is unknown", () => {
    const error = expectConfigError(() => resolveConfig(input({ network: "wat" })), "network");
    expect(error.message).toContain("namespace:reference");
  });

  it("ignores an empty entry in X402_NETWORKS rather than failing", () => {
    const config = resolveConfig(
      input({ network: undefined, env: { X402_NETWORKS: ` , ${EVM} , ` } }),
    );
    expect(config.networks).toEqual([EVM]);
  });

  it("treats an all-empty X402_NETWORKS as absent, not as an empty list", () => {
    const config = resolveConfig(input({ env: { X402_NETWORKS: " , " } }));
    // Falls back to `network`; the point is that it does not throw on the blank.
    expect(config.networks).toEqual([EVM]);
  });

  it("prefers an explicit networks array over the env list", () => {
    const config = resolveConfig(
      input({ networks: [EVM_MAINNET], env: { X402_NETWORKS: SVM } }),
    );
    expect(config.networks).toEqual([EVM_MAINNET]);
  });
});

describe("payTo as a single address", () => {
  it("rejects a string that is only whitespace", () => {
    expectConfigError(() => resolveConfig(input({ payTo: "   " })), "payTo");
  });

  it("trims surrounding whitespace before validating", () => {
    // A copy-pasted address often arrives with a trailing space; the mutant that
    // dropped the trim() would reject a perfectly good address.
    const config = resolveConfig(input({ payTo: ` ${ADDRESS} ` }));
    expect(config.payTo).toBe(ADDRESS);
  });

  it("rejects an EVM address that is too short", () => {
    expectConfigError(() => resolveConfig(input({ payTo: "0xabc" })), "payTo");
  });

  it("rejects an EVM address without the 0x prefix", () => {
    expectConfigError(() => resolveConfig(input({ payTo: ADDRESS.slice(2) })), "payTo");
  });

  it("rejects a Solana address on an EVM network and names the fix", () => {
    const error = expectConfigError(() => resolveConfig(input({ payTo: SOL_ADDRESS })), "payTo");
    expect(error.message).toContain("each network its own address");
  });

  it("rejects an EVM address on a Solana network", () => {
    const error = expectConfigError(
      () => resolveConfig(input({ network: SVM, payTo: ADDRESS })),
      "payTo",
    );
    expect(error.message).toContain("EVM address cannot receive on Solana");
  });
});

describe("payTo as a map", () => {
  it("prefers the exact network id over the namespace and the wildcard", () => {
    const config = resolveConfig(
      input({
        networks: [EVM, EVM_MAINNET],
        payTo: { [EVM]: ADDRESS, eip155: "0x0000000000000000000000000000000000000001", "*": "0x0000000000000000000000000000000000000002" },
      }),
    );
    expect(config.payToByNetwork[EVM]).toBe(ADDRESS);
    expect(config.payToByNetwork[EVM_MAINNET]).toBe("0x0000000000000000000000000000000000000001");
  });

  it("falls back to the wildcard when neither id nor namespace is present", () => {
    const wildcard = "0x0000000000000000000000000000000000000002";
    const config = resolveConfig(
      input({ networks: [EVM, EVM_MAINNET], payTo: { "*": wildcard } }),
    );
    expect(config.payToByNetwork[EVM]).toBe(wildcard);
    expect(config.payToByNetwork[EVM_MAINNET]).toBe(wildcard);
  });

  it("blames payTo and names the network that has no address", () => {
    const error = expectConfigError(
      () => resolveConfig(input({ networks: [EVM, SVM], payTo: { [EVM]: ADDRESS } })),
      "payTo",
    );
    expect(error.message).toContain(SVM);
  });

  it("validates each mapped address against its own network", () => {
    // The map is not an escape hatch: a Solana network given an EVM address must
    // still fail, otherwise the per-network check was decorative.
    expectConfigError(
      () =>
        resolveConfig(
          input({ networks: [EVM, SVM], payTo: { [EVM]: ADDRESS, [SVM]: ADDRESS } }),
        ),
      "payTo",
    );
  });

  it("reads per-network addresses from X402_PAY_TO_<NETWORK>", () => {
    const config = resolveConfig(
      input({
        payTo: undefined,
        networks: undefined,
        env: {
          X402_NETWORKS: `${EVM},${SVM}`,
          X402_PAY_TO: ADDRESS,
          X402_PAY_TO_SOLANA_ETWTRABZAYQ6IMFEYKOURU166VU2XQA1: SOL_ADDRESS,
        },
      }),
    );
    expect(config.payToByNetwork[EVM]).toBe(ADDRESS);
    expect(config.payToByNetwork[SVM]).toBe(SOL_ADDRESS);
  });

  it("accepts the literal network id as the env suffix too", () => {
    const config = resolveConfig(
      input({
        payTo: undefined,
        networks: [EVM],
        env: { [`X402_PAY_TO_${EVM}`]: ADDRESS, X402_NETWORK: EVM },
      }),
    );
    expect(config.payToByNetwork[EVM]).toBe(ADDRESS);
  });
});

describe("prices", () => {
  it("rejects an empty price string", () => {
    expectConfigError(
      () => resolveConfig(input({ routes: [{ route: "GET /x", price: "   " }] })),
      "routes[0]",
    );
  });

  it("rejects a non-string, non-object price", () => {
    expectConfigError(
      () => resolveConfig(input({ routes: [{ route: "GET /x", price: 42 }] })),
      "routes[0]",
    );
  });

  it("adds the dollar prefix once, not twice", () => {
    const config = resolveConfig(
      input({ routes: [{ route: "GET /x", price: "$0.50" }] }),
    );
    expect(toRoutesConfig(config)["GET /x"]?.accepts[0]?.price).toBe("$0.50");
  });

  it("prefixes a bare decimal", () => {
    const config = resolveConfig(input({ routes: [{ route: "GET /x", price: "0.50" }] }));
    expect(toRoutesConfig(config)["GET /x"]?.accepts[0]?.price).toBe("$0.50");
  });
});

describe("routes", () => {
  it("rejects a route with a method but no path", () => {
    expectConfigError(
      () => resolveConfig(input({ routes: [{ route: "GET ", price: "0.1" }] })),
      "routes[0]",
    );
  });

  it("rejects an empty route string", () => {
    expectConfigError(
      () => resolveConfig(input({ routes: [{ route: "   ", price: "0.1" }] })),
      "routes[0]",
    );
  });

  it("rejects a path without a leading slash", () => {
    // Without this, "GET weather" silently becomes a path named "weather" that
    // Express never matches, so the route is unprotected while looking fine.
    const error = expectConfigError(
      () => resolveConfig(input({ routes: [{ route: "GET weather", price: "0.1" }] })),
      "routes[0]",
    );
    expect(error.message).toContain("does not start with");
  });

  it("defaults the method to GET and uppercases an explicit one", () => {
    const config = resolveConfig(
      input({
        routes: [
          { route: "/bare", price: "0.1" },
          { method: "post", path: "/echo", price: "0.2" },
        ],
      }),
    );
    expect(config.routes.map(route => `${route.method} ${route.path}`)).toEqual([
      "GET /bare",
      "POST /echo",
    ]);
  });

  it("reads X402_PRICE__ variables, ignoring malformed ones", () => {
    const config = resolveConfig(
      input({
        routes: undefined,
        env: {
          "X402_PRICE__GET_/weather": "0.001",
          "X402_PRICE__NOSEPARATOR": "0.5",
          "X402_PRICE__GET_": "0.5",
        },
      }),
    );
    expect(config.routes).toEqual([{ method: "GET", path: "/weather", price: "0.001" }]);
  });

  it("rejects a non-positive settlement timeout from env", () => {
    expectConfigError(
      () => resolveConfig(input({ env: { X402_MAX_TIMEOUT_SECONDS: "0" } })),
      "maxTimeoutSeconds",
    );
  });

  it("rejects a non-numeric settlement timeout", () => {
    expectConfigError(
      () => resolveConfig(input({ env: { X402_MAX_TIMEOUT_SECONDS: "soon" } })),
      "maxTimeoutSeconds",
    );
  });

  it("defaults the settlement timeout to 60", () => {
    expect(resolveConfig(input()).maxTimeoutSeconds).toBe(60);
  });

  it("lets a route override the global timeout", () => {
    const config = resolveConfig(
      input({ maxTimeoutSeconds: 30, routes: [{ route: "GET /slow", price: "1", maxTimeoutSeconds: 300 }] }),
    );
    expect(toRoutesConfig(config)["GET /slow"]?.accepts[0]?.maxTimeoutSeconds).toBe(300);
  });
});

describe("facilitator auth", () => {
  it("builds bearer headers for all three endpoints from a token", () => {
    const config = resolveConfig(input({ env: { X402_FACILITATOR_TOKEN: "t" } }));
    expect(config.facilitatorHeaders).toEqual({
      verify: { Authorization: "Bearer t" },
      settle: { Authorization: "Bearer t" },
      supported: { Authorization: "Bearer t" },
    });
  });

  it("omits headers entirely when no token is set", () => {
    expect(resolveConfig(input()).facilitatorHeaders).toBeUndefined();
  });

  it("prefers explicit headers over the env token", () => {
    const headers = {
      verify: { "x-key": "explicit" },
      settle: { "x-key": "explicit" },
      supported: { "x-key": "explicit" },
    };
    const config = resolveConfig(
      input({
        env: { X402_FACILITATOR_TOKEN: "env" },
        facilitatorHeaders: headers,
      }),
    );
    expect(config.facilitatorHeaders).toEqual(headers);
  });

  it("rejects a flat facilitatorHeaders object at config time", () => {
    expectConfigError(
      () =>
        resolveConfig(
          input({
            facilitatorHeaders: { Authorization: "Bearer flat-token" },
          }),
        ),
      "facilitatorHeaders",
    );
  });

  it("accepts per-path facilitatorHeaders including bazaar", () => {
    const config = resolveConfig(
      input({
        facilitatorHeaders: {
          verify: { "x-key": "v" },
          settle: { "x-key": "v" },
          supported: { "x-key": "v" },
          bazaar: { "x-key": "b" },
        },
      }),
    );
    expect(config.facilitatorHeaders).toEqual({
      verify: { "x-key": "v" },
      settle: { "x-key": "v" },
      supported: { "x-key": "v" },
      bazaar: { "x-key": "b" },
    });
  });

  it("rejects facilitatorHeaders missing settle or supported", () => {
    expectConfigError(
      () =>
        resolveConfig(
          input({
            facilitatorHeaders: {
              verify: { "x-key": "v" },
              bazaar: { "x-key": "b" },
            },
          }),
        ),
      "facilitatorHeaders",
    );
  });

  it("assertLensConfig rejects flat headers on a pre-built config", () => {
    const config = resolveConfig(input()) as LensConfig;
    expectConfigError(
      () =>
        assertLensConfig({
          ...config,
          facilitatorHeaders: { Authorization: "Bearer flat" } as LensConfig["facilitatorHeaders"],
        }),
      "facilitatorHeaders",
    );
  });

  it("assertLensConfig rejects a bad payTo on a pre-built config", () => {
    const config = resolveConfig(input()) as LensConfig;
    expectConfigError(
      () =>
        assertLensConfig({
          ...config,
          payTo: "not-an-address",
          payToByNetwork: { [EVM]: "not-an-address" },
        }),
      "payTo",
    );
  });

  it("assertLensConfig rejects an empty price on a pre-built config", () => {
    const config = resolveConfig(input()) as LensConfig;
    expectConfigError(
      () =>
        assertLensConfig({
          ...config,
          routes: [{ method: "GET", path: "/weather", price: "   " }],
        }),
      "routes[0]",
    );
  });

  it("assertLensConfig rejects an unknown scheme on a pre-built config", () => {
    const config = resolveConfig(input()) as LensConfig;
    expectConfigError(
      () =>
        assertLensConfig({
          ...config,
          routes: [
            {
              method: "GET",
              path: "/weather",
              price: "0.001",
              scheme: "mystery" as LensConfig["routes"][number]["scheme"],
            },
          ],
        }),
      "routes",
    );
  });

  it("assertLensConfig rejects a bad paymentFlow on a pre-built config", () => {
    const config = resolveConfig(input()) as LensConfig;
    expectConfigError(
      () =>
        assertLensConfig({
          ...config,
          routes: [
            {
              method: "GET",
              path: "/weather",
              price: "0.001",
              paymentFlow: "typo" as LensConfig["routes"][number]["paymentFlow"],
            },
          ],
        }),
      "routes",
    );
  });

  it("assertLensConfig trims whitespace on hand-built string prices", () => {
    const config = resolveConfig(input()) as LensConfig;
    const routes = [{ method: "GET", path: "/weather", price: "  0.001  " }];
    assertLensConfig({ ...config, routes });
    expect(routes[0]?.price).toBe("0.001");
  });

  it("rejects blank facilitator header values", () => {
    expectConfigError(
      () =>
        resolveConfig(
          input({
            facilitatorHeaders: {
              verify: { Authorization: " " },
              settle: { Authorization: "Bearer ok" },
              supported: { Authorization: "Bearer ok" },
            },
          }),
        ),
      "facilitatorHeaders",
    );
  });

  it("rejects an unrooted path in the array { method, path } form", () => {
    expectConfigError(
      () =>
        resolveConfig(
          input({
            routes: [{ method: "GET", path: "weather", price: "0.001" }],
          }),
        ),
      "routes[0]",
    );
  });

  it("rejects a zero or negative facilitator timeout", () => {
    for (const value of [0, -5]) {
      expectConfigError(() => resolveConfig(input({ facilitatorTimeoutMs: value })), "facilitatorTimeoutMs");
    }
  });

  it("rejects a non-integer facilitator timeout", () => {
    expectConfigError(
      () => resolveConfig(input({ facilitatorTimeoutMs: 1.5 })),
      "facilitatorTimeoutMs",
    );
  });
});

describe("route metadata", () => {
  it("drops empty values rather than emitting empty strings", () => {
    const config = resolveConfig(
      input({
        routes: [
          { route: "GET /x", price: "0.1", description: "", tags: [], mimeType: "", serviceName: "", iconUrl: "" },
        ],
      }),
    );
    const route = toRoutesConfig(config)["GET /x"];
    expect(route?.description).toBeUndefined();
    expect(route?.mimeType).toBeUndefined();
    expect(route?.serviceName).toBeUndefined();
    expect(route?.iconUrl).toBeUndefined();
    expect(route?.tags).toBeUndefined();
  });

  it("copies tags so mutating the input cannot change config", () => {
    const tags = ["a"];
    const config = resolveConfig(input({ routes: [{ route: "GET /x", price: "0.1", tags }] }));
    tags.push("b");
    expect(toRoutesConfig(config)["GET /x"]?.tags).toEqual(["a"]);
  });
});
