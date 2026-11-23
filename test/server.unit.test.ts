/**
 * Unit tests for the shared payment path.
 *
 * `@x402-lens/server` had no direct tests at all: everything was exercised
 * indirectly through the two adapters, which means a mutant could change routing
 * or event shaping and still pass, because the integration tests only assert the
 * paths they happen to take. Mutation testing on the package scored 53%, and
 * every surviving mutant below is a specific gap this file closes.
 *
 * These test the functions, not a running server: the point is the decision
 * each one makes, which is exactly what a mutation flips.
 */

import { describe, expect, it } from "vitest";
import type { LensConfig } from "@x402-lens/core";
import {
  MAX_REASON_LENGTH,
  buildCorsHeaders,
  matchRouteConfig,
  mergeCorsHeaders,
  pathMatchesPattern,
  safeCall,
  syntheticChallenge,
} from "@x402-lens/server";

/** Minimal config shape; only the fields under test are meaningful. */
function configWith(routes: Array<{ method: string; path: string }>): LensConfig {
  return {
    routes: routes.map(route => ({ ...route, price: "$0.001" })),
    network: "eip155:84532",
    networks: ["eip155:84532"],
    payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    payToByNetwork: {},
  } as unknown as LensConfig;
}

describe("pathMatchesPattern", () => {
  it("matches identical paths", () => {
    expect(pathMatchesPattern("/weather", "/weather")).toBe(true);
  });

  it("rejects paths with a different segment count", () => {
    expect(pathMatchesPattern("/weather", "/weather/today")).toBe(false);
    expect(pathMatchesPattern("/a/b", "/a")).toBe(false);
  });

  it("treats a `:param` segment as a wildcard for exactly one segment", () => {
    expect(pathMatchesPattern("/users/:id", "/users/42")).toBe(true);
    expect(pathMatchesPattern("/users/:id/posts", "/users/42/posts")).toBe(true);
    // One segment means one: a nested path must not match.
    expect(pathMatchesPattern("/users/:id", "/users/42/posts")).toBe(false);
  });

  it("treats `*` as a wildcard segment", () => {
    expect(pathMatchesPattern("/files/*", "/files/report.pdf")).toBe(true);
    expect(pathMatchesPattern("/files/*", "/files")).toBe(false);
  });

  it("rejects literal segments that differ", () => {
    expect(pathMatchesPattern("/weather", "/climate")).toBe(false);
    expect(pathMatchesPattern("/a/b", "/a/c")).toBe(false);
  });

  it("does not treat a partial segment prefix as a param", () => {
    // `:id` is a param; `id` is literal. A mutant that loosened
    // `startsWith(":")` would make this match and route the wrong config.
    expect(pathMatchesPattern("/users/id", "/users/42")).toBe(false);
  });
});

describe("matchRouteConfig", () => {
  it("prefers an exact path over a pattern", () => {
    const config = configWith([
      { method: "GET", path: "/users/:id" },
      { method: "GET", path: "/users/me" },
    ]);
    const match = matchRouteConfig(config, "GET", "/users/me");

    // Both routes match; the exact one must win, or `/users/me` would be
    // granted against the param route's config.
    expect((match as { path?: string } | undefined)?.path).toBe("/users/me");
  });

  it("falls back to a pattern when no exact path matches", () => {
    const config = configWith([{ method: "GET", path: "/users/:id" }]);
    expect((matchRouteConfig(config, "GET", "/users/42") as { path?: string } | undefined)?.path).toBe(
      "/users/:id",
    );
  });

  it("matches a method-less `*` route for any verb", () => {
    const config = configWith([{ method: "*", path: "/anything" }]);
    expect(matchRouteConfig(config, "POST", "/anything")).toBeDefined();
  });

  it("does not return a route for a different method", () => {
    const config = configWith([{ method: "GET", path: "/weather" }]);
    expect(matchRouteConfig(config, "POST", "/weather")).toBeUndefined();
  });

  it("returns undefined when nothing matches", () => {
    const config = configWith([{ method: "GET", path: "/weather" }]);
    expect(matchRouteConfig(config, "GET", "/unknown")).toBeUndefined();
  });
});

describe("buildCorsHeaders", () => {
  it("returns nothing when cors is off", () => {
    expect(buildCorsHeaders(undefined)).toBeUndefined();
    expect(buildCorsHeaders(false)).toBeUndefined();
  });

  it("names the three payment headers when cors is a bare true", () => {
    const headers = buildCorsHeaders(true);
    expect(headers?.["Access-Control-Expose-Headers"]).toContain("PAYMENT-REQUIRED");
    expect(headers?.["Access-Control-Expose-Headers"]).toContain("PAYMENT-RESPONSE");
    expect(headers?.["Access-Control-Allow-Headers"]).toContain("PAYMENT-SIGNATURE");
    // A credentialed request needs Content-Type listed: the retry carries JSON.
    expect(headers?.["Access-Control-Allow-Headers"]).toContain("Content-Type");
    // `cors: true` must not invent an origin — the app owns that decision.
    expect(headers?.["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("sets Allow-Origin and Vary for a specific origin", () => {
    const headers = buildCorsHeaders({ origin: "https://example.com" });
    expect(headers?.["Access-Control-Allow-Origin"]).toBe("https://example.com");
    // Without Vary the response can be cached and replayed to another origin.
    expect(headers?.Vary).toBe("Origin");
  });

  it("omits Vary for a wildcard origin, where it would be meaningless", () => {
    const headers = buildCorsHeaders({ origin: "*" });
    expect(headers?.["Access-Control-Allow-Origin"]).toBe("*");
    expect(headers?.Vary).toBeUndefined();
  });
});

describe("mergeCorsHeaders", () => {
  it("unions list headers with what the app already set", () => {
    const merged = mergeCorsHeaders(
      name => (name === "Access-Control-Expose-Headers" ? "X-Custom-Header" : undefined),
      { "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE" },
    );

    // An app with its own CORS layer must keep its headers.
    expect(merged["Access-Control-Expose-Headers"]).toContain("X-Custom-Header");
    expect(merged["Access-Control-Expose-Headers"]).toContain("PAYMENT-REQUIRED");
  });

  it("does not duplicate a value that is already present", () => {
    const merged = mergeCorsHeaders(
      () => "PAYMENT-REQUIRED",
      { "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE" },
    );

    const occurrences = merged["Access-Control-Expose-Headers"]?.split("PAYMENT-REQUIRED").length ?? 0;
    expect(occurrences - 1).toBe(1);
  });

  it("replaces Allow-Origin rather than joining it", () => {
    // A comma-joined ACAO is a value browsers reject outright, so merging here
    // would break every browser buyer.
    const merged = mergeCorsHeaders(
      () => "https://old.example.com",
      { "Access-Control-Allow-Origin": "https://example.com" },
    );

    expect(merged["Access-Control-Allow-Origin"]).toBe("https://example.com");
    expect(merged["Access-Control-Allow-Origin"]).not.toContain(",");
  });

  it("unions Vary instead of replacing it", () => {
    // `Vary` is a list header. Treating it as a singleton dropped what the app
    // had already set: merging `Vary: Accept-Encoding, Origin` with the lens's
    // `Vary: Origin` produced `Vary: Origin`, so a cache could serve a gzipped
    // body to a client that never asked for one. That is a correctness bug in
    // the response, not just a header detail.
    const merged = mergeCorsHeaders(() => "Accept-Encoding, Origin", { Vary: "Origin" });

    expect(merged.Vary).toContain("Accept-Encoding");
    expect(merged.Vary).toContain("Origin");
    // And no duplicate, since `Origin` was in both.
    expect(merged.Vary?.split("Origin").length).toBe(2);
  });
});

describe("syntheticChallenge", () => {
  it("wraps one requirement in a v2 challenge", () => {
    const challenge = syntheticChallenge({
      scheme: "exact",
      network: "eip155:84532",
      amount: "1000",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    });

    // The verify-path diagnosis reuses the same rules as the 402 path, and it
    // needs a challenge-shaped input to do it.
    expect(challenge.x402Version).toBe(2);
    expect(challenge.accepts).toHaveLength(1);
    expect(challenge.accepts?.[0]?.amount).toBe("1000");
  });
});

describe("safeCall", () => {
  it("returns the value when the accessor works", () => {
    expect(safeCall(() => "value")).toBe("value");
  });

  it("returns undefined instead of throwing", () => {
    // Adapters are third-party code; a throwing accessor must not become a 500.
    expect(safeCall(() => {
      throw new Error("adapter exploded");
    })).toBeUndefined();
  });
});

describe("MAX_REASON_LENGTH", () => {
  it("is the cap the adapters apply to denial reasons", () => {
    // Pinned because both adapters and their tests depend on this exact number:
    // a change here silently changes how much internal text reaches a log.
    expect(MAX_REASON_LENGTH).toBe(200);
  });
});
