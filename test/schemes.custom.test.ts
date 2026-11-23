/**
 * Registering schemes this package does not ship.
 *
 * `batch-settlement` and `auth-capture` exist in the SDK and were recorded in
 * PLAN.md as unregistered. Reading their types showed why naming them in
 * configuration cannot work: both need runtime objects — channel storage, an
 * authorizer signer — which an environment variable cannot express. So the
 * caller passes the built scheme instead of a name.
 *
 * The second half of this file guards a mistake made while adding it: the option
 * was declared on the shared layer but not forwarded by either adapter, so the
 * feature was unreachable while its own tests passed. A source assertion catches
 * that; a behaviour test cannot.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { LensConfig } from "@x402-lens/core";
import { buildServers, type CustomSchemeRegistration } from "@x402-lens/server";

const root = resolve(import.meta.dirname, "..");

function source(packageName: string): string {
  return readFileSync(resolve(root, `packages/${packageName}/src/index.ts`), "utf8");
}

/** A minimal config; only fields read during registration matter here. */
function configFor(networks: string[]): LensConfig {
  return {
    facilitatorUrl: "http://127.0.0.1:1",
    network: networks[0] ?? "eip155:84532",
    networks,
    payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    payToByNetwork: {},
    routes: [],
    maxTimeoutSeconds: 60,
  } as unknown as LensConfig;
}

/** A scheme instance the resource server can register. */
function fakeScheme(name: string) {
  return {
    scheme: name,
    defaultAssetTransferMethod: "eip3009",
    paymentFlows: { eip3009: { supported: ["authorization"], default: "authorization" } },
  } as never;
}

function registration(network: string, scheme: string): CustomSchemeRegistration {
  return { network, scheme, implementation: fakeScheme(scheme) };
}

describe("buildServers: custom schemes", () => {
  it("accepts a network this package does not ship when a scheme is supplied", () => {
    // Without the custom registration this throws on `xrpl`; with it, the
    // builder completes and the network is genuinely usable. Not asserting
    // "initialize() did not throw" — that would fire a real facilitator request
    // and prove nothing about registration.
    const servers = buildServers(configFor(["xrpl:1"]), {
      sinks: { console: false },
      extraSchemes: [registration("xrpl:1", "exact")],
    });

    expect(servers.server.getRegisteredScheme("xrpl:1" as never, "exact")).toBeDefined();
  });

  it("registers a scheme that is not exact on a shipped network", () => {
    const servers = buildServers(configFor(["eip155:84532"]), {
      sinks: { console: false },
      extraSchemes: [registration("eip155:84532", "batch-settlement")],
    });

    // The point of the feature: `batch-settlement` is in the SDK but cannot be
    // named in configuration, because it needs runtime storage.
    expect(
      servers.server.getRegisteredScheme("eip155:84532" as never, "batch-settlement"),
    ).toBeDefined();
    // The built-in `exact` is still registered alongside it.
    expect(servers.server.getRegisteredScheme("eip155:84532" as never, "exact")).toBeDefined();
  });

  it("still throws for a namespace with no scheme at all", () => {
    // Silence here would mean a route that can never be paid, discovered by a
    // buyer rather than at startup.
    expect(() => buildServers(configFor(["xrpl:1"]), { sinks: { console: false } })).toThrow(
      /No scheme for namespace "xrpl"/,
    );
  });

  it("names extraSchemes in the unsupported-namespace error", () => {
    // The previous message told the reader to call server.register() themselves
    // — impossible, because the throw happens before the caller sees the server.
    expect(() => buildServers(configFor(["xrpl:1"]), { sinks: { console: false } })).toThrow(
      /extraSchemes/,
    );
  });
});

describe("adapters forward extraSchemes", () => {
  for (const adapter of ["express", "hono"]) {
    it(`${adapter} exposes extraSchemes in its options type`, () => {
      // Declared on the shared layer is not the same as reachable: both adapters
      // spell their options out field by field instead of extending
      // LensCommonOptions, so a new shared option has to be added again here.
      // That was missed once for exactly this option.
      expect(source(adapter)).toMatch(/extraSchemes\?\s*:\s*CustomSchemeRegistration\[\]/);
    });

    it(`${adapter} passes the whole options object to buildServers`, () => {
      // Both adapters forward `options` wholesale to `buildServers`, so a field
      // added to the options type reaches the builder without a second edit.
      // Asserting that shape — rather than the presence of a named argument —
      // is what makes this robust against reformatting.
      const src = source(adapter);
      expect(src).toContain("buildServers(");
      // `options` must appear as an argument, not be reconstructed field by
      // field: a rebuilt object is exactly how a new option gets dropped.
      const call = src.slice(src.indexOf("buildServers(")).slice(0, 200);
      expect(call).toMatch(/\boptions\b/);
    });
  }

  it("the shared layer reads extraSchemes", () => {
    // Guards the other half: an adapter can forward a field the builder ignores.
    expect(source("server")).toMatch(/options\.extraSchemes/);
  });
});
