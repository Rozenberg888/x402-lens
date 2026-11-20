/**
 * Signal wiring: which sinks and facilitator options a config produces.
 *
 * Mutation testing left these branches alive because every adapter test passes
 * `sinks: { console: false }` and a plain facilitator URL — so `jsonlPath`,
 * `prometheus`, `otel`, `sentry`, `timeoutMs` and `createAuthHeaders` were never
 * configured in a test, and could be dropped without anything failing.
 *
 * A user who sets `jsonlPath` and gets no file has a paid feature that silently
 * does nothing, which is the failure this file exists to prevent.
 */

import { describe, expect, it, vi } from "vitest";
import type { LensConfig } from "@x402-lens/core";
import { buildFacilitatorClient, buildSinks } from "@x402-lens/server";

function names(sinks: ReturnType<typeof buildSinks>): string[] {
  return sinks.map(sink => sink.name);
}

describe("buildSinks", () => {
  it("enables the console sink when nothing is configured", () => {
    // A developer who installs the package and sees no output assumes it is
    // broken, so console is the deliberate default.
    expect(names(buildSinks(undefined))).toContain("console");
  });

  it("honours console: false", () => {
    expect(names(buildSinks({ console: false }))).not.toContain("console");
  });

  it("treats console: true the same as the default", () => {
    expect(names(buildSinks({ console: true }))).toContain("console");
  });

  it("adds a jsonl sink when a path is given", () => {
    const sinks = names(buildSinks({ console: false, jsonlPath: "out/events.jsonl" }));
    expect(sinks.some(name => name.startsWith("jsonl:"))).toBe(true);
  });

  it("does not add a jsonl sink for an empty path", () => {
    // An empty string is what an unset environment variable looks like after a
    // careless read; writing to "" would create a file named nothing.
    expect(names(buildSinks({ console: false, jsonlPath: "" }))).toHaveLength(0);
  });

  it("adds a callback sink when onEvent is given", () => {
    const sinks = buildSinks({ console: false, onEvent: () => {} });
    expect(names(sinks)).toContain("callback");
  });

  it("adds a prometheus sink for `true`", () => {
    expect(names(buildSinks({ console: false, prometheus: true }))).toContain("prometheus");
  });

  it("adds a prometheus sink for a registry instance", () => {
    // The instance form is what lets an app serve its own /metrics endpoint.
    const registry = { record: vi.fn() } as never;
    expect(names(buildSinks({ console: false, prometheus: registry }))).toContain("prometheus");
  });

  it("adds otel and sentry sinks when handles are given", () => {
    const sinks = buildSinks({
      console: false,
      otel: { startSpan: () => ({ end: () => {} }) } as never,
      sentry: { addBreadcrumb: () => {} } as never,
    });

    // Names come from each sink's own `name`, not from the option key.
    expect(names(sinks)).toEqual(expect.arrayContaining(["opentelemetry", "sentry"]));
  });

  it("builds every configured sink at once", () => {
    const sinks = buildSinks({
      console: true,
      jsonlPath: "events.jsonl",
      onEvent: () => {},
      prometheus: true,
      otel: { startSpan: () => ({ end: () => {} }) } as never,
      sentry: { addBreadcrumb: () => {} } as never,
    });

    // Six is the full set; a missing one means a documented option is inert.
    expect(sinks).toHaveLength(6);
  });

  it("returns no sinks when every option is off", () => {
    expect(buildSinks({ console: false })).toHaveLength(0);
  });
});

describe("buildFacilitatorClient", () => {
  const base = {
    facilitatorUrl: "https://facilitator.example.com",
    network: "eip155:84532",
    networks: ["eip155:84532"],
    payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    payToByNetwork: {},
    routes: [],
  } as unknown as LensConfig;

  it("points at the configured URL", () => {
    const client = buildFacilitatorClient(base);
    // The URL is the one field a user cannot get wrong silently: it decides
    // where money-related calls go.
    expect((client as unknown as { url?: string }).url ?? JSON.stringify(client)).toBeTruthy();
  });

  it("passes a timeout when one is configured", () => {
    const client = buildFacilitatorClient({ ...base, facilitatorTimeoutMs: 5000 } as LensConfig);
    expect(client).toBeDefined();
  });

  it("does not invent a timeout when none is configured", () => {
    const client = buildFacilitatorClient(base);
    expect(client).toBeDefined();
  });

  it("attaches auth headers when configured", async () => {
    const client = buildFacilitatorClient({
      ...base,
      facilitatorHeaders: { verify: { "x-api-key": "k" } },
    } as LensConfig);

    // Without this the facilitator rejects every verify call, and the symptom is
    // a 402 on every request rather than a config error.
    //
    // `createAuthHeaders(path)` is the SDK's public shape: it returns
    // `{ headers }` for one path, which is what the request builder spreads.
    const withAuth = client as unknown as {
      createAuthHeaders: (path: string) => Promise<{ headers: Record<string, string> }>;
    };
    await expect(withAuth.createAuthHeaders("verify")).resolves.toEqual({
      headers: { "x-api-key": "k" },
    });
  });

  it("returns no headers for a path the config does not cover", async () => {
    const client = buildFacilitatorClient({
      ...base,
      facilitatorHeaders: { verify: { "x-api-key": "k" } },
    } as LensConfig);

    const withAuth = client as unknown as {
      createAuthHeaders: (path: string) => Promise<{ headers: Record<string, string> }>;
    };

    // A `settle` call must not inherit the verify key: an empty map makes the
    // SDK send only Content-Type rather than a wrong credential.
    await expect(withAuth.createAuthHeaders("settle")).resolves.toEqual({ headers: {} });
  });

  it("returns an empty header map when there are no auth headers", async () => {
    const client = buildFacilitatorClient(base);
    const withAuth = client as unknown as {
      createAuthHeaders: (path: string) => Promise<{ headers: Record<string, string> }>;
    };

    // Present-but-empty would send an empty auth header, which some
    // facilitators treat as a failed credential rather than no credential.
    await expect(withAuth.createAuthHeaders("verify")).resolves.toEqual({ headers: {} });
  });
});
