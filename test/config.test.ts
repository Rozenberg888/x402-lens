/**
 * Configuration must never invent a facilitator, network, or address.
 *
 * These tests exist because the failure mode is silent and expensive: a
 * defaulted facilitator on the wrong chain means money lands nowhere.
 */

import { describe, expect, it } from "vitest";
import { ConfigError, resolveConfig } from "@x402-lens/core";

const base = {
  env: {} as Record<string, string | undefined>,
};

describe("required fields", () => {
  it("rejects a missing facilitator URL", () => {
    expect(() =>
      resolveConfig({
        network: "eip155:84532",
        payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
        routes: [{ route: "GET /weather", price: "0.001" }],
        ...base,
      }),
    ).toThrow(ConfigError);
  });

  it("rejects a missing network", () => {
    expect(() =>
      resolveConfig({
        facilitatorUrl: "https://x402.org/facilitator",
        payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
        routes: [{ route: "GET /weather", price: "0.001" }],
        ...base,
      }),
    ).toThrow(ConfigError);
  });

  it("rejects a missing payTo", () => {
    expect(() =>
      resolveConfig({
        facilitatorUrl: "https://x402.org/facilitator",
        network: "eip155:84532",
        routes: [{ route: "GET /weather", price: "0.001" }],
        ...base,
      }),
    ).toThrow(ConfigError);
  });

  it("rejects an empty route list", () => {
    expect(() =>
      resolveConfig({
        facilitatorUrl: "https://x402.org/facilitator",
        network: "eip155:84532",
        payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
        routes: [],
        ...base,
      }),
    ).toThrow(/No routes configured/);
  });

  it("names the env var to set", () => {
    try {
      resolveConfig({ network: "eip155:84532", payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C", routes: [], ...base });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as ConfigError).message).toContain("X402_FACILITATOR_URL");
      expect((error as ConfigError).message).toContain("never defaults it");
    }
  });
});

describe("network validation", () => {
  it("rejects a v1 shorthand and suggests the CAIP-2 id", () => {
    try {
      resolveConfig({
        facilitatorUrl: "https://x402.org/facilitator",
        network: "base-sepolia",
        payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
        routes: [{ route: "GET /weather", price: "0.001" }],
        ...base,
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as ConfigError).field).toBe("network");
      expect((error as ConfigError).message).toContain("eip155:84532");
    }
  });

  it("accepts an EVM CAIP-2 id", () => {
    const config = resolveConfig({
      facilitatorUrl: "https://x402.org/facilitator",
      network: "eip155:84532",
      payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      routes: [{ route: "GET /weather", price: "0.001" }],
      ...base,
    });
    expect(config.network).toBe("eip155:84532");
  });

  it("accepts a Solana CAIP-2 id", () => {
    const config = resolveConfig({
      facilitatorUrl: "https://x402.org/facilitator",
      network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      payTo: "So11111111111111111111111111111111111111112",
      routes: [{ route: "GET /weather", price: "0.001" }],
      ...base,
    });
    expect(config.network).toContain("solana:");
  });
});

describe("facilitator URL validation", () => {
  it("rejects a non-URL", () => {
    expect(() =>
      resolveConfig({
        facilitatorUrl: "not a url",
        network: "eip155:84532",
        payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
        routes: [{ route: "GET /weather", price: "0.001" }],
        ...base,
      }),
    ).toThrow(/not a valid URL/);
  });

  it("rejects non-http protocols", () => {
    expect(() =>
      resolveConfig({
        facilitatorUrl: "ftp://x402.org/facilitator",
        network: "eip155:84532",
        payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
        routes: [{ route: "GET /weather", price: "0.001" }],
        ...base,
      }),
    ).toThrow(/http\(s\)/);
  });

  it("strips a trailing slash so URL joins stay clean", () => {
    const config = resolveConfig({
      facilitatorUrl: "https://x402.org/facilitator/",
      network: "eip155:84532",
      payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      routes: [{ route: "GET /weather", price: "0.001" }],
      ...base,
    });
    expect(config.facilitatorUrl).toBe("https://x402.org/facilitator");
  });
});

describe("environment precedence", () => {
  it("prefers explicit options over env", () => {
    const config = resolveConfig({
      facilitatorUrl: "https://explicit.example/facilitator",
      env: { X402_FACILITATOR_URL: "https://env.example/facilitator" },
      network: "eip155:84532",
      payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      routes: [{ route: "GET /weather", price: "0.001" }],
    });
    expect(config.facilitatorUrl).toBe("https://explicit.example/facilitator");
  });

  it("falls back to env", () => {
    const config = resolveConfig({
      env: {
        X402_FACILITATOR_URL: "https://x402.org/facilitator",
        X402_NETWORK: "eip155:84532",
        X402_PAY_TO: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
        "X402_PRICE__GET_/weather": "0.001",
      },
    });
    expect(config.network).toBe("eip155:84532");
    expect(config.routes).toEqual([{ method: "GET", path: "/weather", price: "0.001" }]);
  });

  it("reads method and path out of X402_PRICE__ variables", () => {
    const config = resolveConfig({
      facilitatorUrl: "https://x402.org/facilitator",
      network: "eip155:84532",
      payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      env: { "X402_PRICE__POST_/api/echo": "0.05" },
    });
    expect(config.routes).toEqual([{ method: "POST", path: "/api/echo", price: "0.05" }]);
  });

  it("honours X402_MAX_TIMEOUT_SECONDS", () => {
    const config = resolveConfig({
      facilitatorUrl: "https://x402.org/facilitator",
      network: "eip155:84532",
      payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      env: { X402_MAX_TIMEOUT_SECONDS: "120" },
      routes: [{ route: "GET /weather", price: "0.001" }],
    });
    expect(config.maxTimeoutSeconds).toBe(120);
  });
});

describe("route normalisation", () => {
  it("parses the short route form", () => {
    const config = resolveConfig({
      facilitatorUrl: "https://x402.org/facilitator",
      network: "eip155:84532",
      payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      routes: [{ route: "GET /weather", price: "0.001" }],
      ...base,
    });
    expect(config.routes[0]).toMatchObject({ method: "GET", path: "/weather", price: "0.001" });
  });

  it("defaults the method to GET when only a path is given", () => {
    const config = resolveConfig({
      facilitatorUrl: "https://x402.org/facilitator",
      network: "eip155:84532",
      payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      routes: [{ route: "/weather", price: "0.001" }],
      ...base,
    });
    expect(config.routes[0]?.method).toBe("GET");
  });

  it("keeps an explicit method", () => {
    const config = resolveConfig({
      facilitatorUrl: "https://x402.org/facilitator",
      network: "eip155:84532",
      payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      routes: [{ method: "post", path: "/echo", price: "2" }],
      ...base,
    });
    expect(config.routes[0]?.method).toBe("POST");
  });
});
