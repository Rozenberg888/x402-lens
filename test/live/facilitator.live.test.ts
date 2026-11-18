/**
 * Live smoke against the public facilitator.
 *
 * Opt-in: these tests reach the network, so they are excluded from the default
 * `vitest run` (see `vitest.live.config.ts`). They exist to catch the one thing
 * mocks cannot — the facilitator changing what it supports.
 *
 *   npm run test:live
 */

import { describe, expect, it } from "vitest";
import { runDoctor } from "../../packages/cli/src/commands/doctor";

const FACILITATOR = process.env.X402_LIVE_FACILITATOR ?? "https://x402.org/facilitator";

describe("public facilitator", () => {
  it("advertises the exact scheme on Base Sepolia for x402Version 2", async () => {
    const response = await fetch(`${FACILITATOR}/supported`, {
      signal: AbortSignal.timeout(30_000),
    });
    expect(response.ok).toBe(true);

    const supported = (await response.json()) as {
      kinds: Array<{ x402Version: number; scheme: string; network: string }>;
    };

    const baseSepolia = supported.kinds.find(
      kind =>
        kind.network === "eip155:84532" && kind.scheme === "exact" && kind.x402Version === 2,
    );
    expect(baseSepolia).toBeDefined();
  });

  it("advertises the exact scheme on Solana devnet for x402Version 2", async () => {
    const response = await fetch(`${FACILITATOR}/supported`, {
      signal: AbortSignal.timeout(30_000),
    });
    const supported = (await response.json()) as {
      kinds: Array<{ x402Version: number; scheme: string; network: string }>;
    };

    const devnet = supported.kinds.find(
      kind =>
        kind.network === "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" &&
        kind.scheme === "exact" &&
        kind.x402Version === 2,
    );
    expect(devnet).toBeDefined();
  });

  it("passes doctor for eip155:84532", async () => {
    const result = await runDoctor({
      facilitatorUrl: FACILITATOR,
      network: "eip155:84532",
    });
    expect(result.text).toContain("exact scheme: The facilitator supports");
    expect(result.exitCode).toBe(0);
  });

  it("passes doctor for solana devnet", async () => {
    const result = await runDoctor({
      facilitatorUrl: FACILITATOR,
      network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    });
    expect(result.exitCode).toBe(0);
  });

  it("still advertises at least one non-exact scheme somewhere (upto drift signal)", async () => {
    const response = await fetch(`${FACILITATOR}/supported`, {
      signal: AbortSignal.timeout(30_000),
    });
    expect(response.ok).toBe(true);
    const supported = (await response.json()) as {
      kinds: Array<{ x402Version: number; scheme: string; network: string }>;
    };
    const schemes = new Set(
      supported.kinds.filter(kind => kind.x402Version === 2).map(kind => kind.scheme),
    );
    // Soft signal: if the public facilitator drops every non-exact scheme, we
    // want a red live run rather than discovering it only after a deploy.
    expect(schemes.size).toBeGreaterThan(0);
    expect(schemes.has("exact")).toBe(true);
  });
});
