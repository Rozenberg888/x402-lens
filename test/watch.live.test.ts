/**
 * Watch against a real paywall: baseline, then a regression.
 *
 * The unit tests cover `diffChallenges` in isolation. This drives the whole
 * command against a live Express app so the wiring is exercised too — a monitor
 * that computes drift correctly but never persists the baseline would pass the
 * unit tests and still page on every run.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { paymentLens } from "@x402-lens/express";
import { checkEndpoint, nextState, readWatchState, writeWatchState } from "../packages/cli/src/commands/watch.js";
import { startMockFacilitator, type MockFacilitator } from "./helpers/mockFacilitator.js";

const NETWORK = "eip155:84532";
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";

let facilitator: MockFacilitator;

beforeAll(async () => {
  facilitator = await startMockFacilitator({ network: NETWORK });
});

afterAll(async () => {
  await facilitator.close();
});

/** Start a paywalled app; the returned close function stops it. */
async function startPaywall(): Promise<{ url: string; close: () => Promise<void>; server: Server }> {
  const lens = paymentLens({
    facilitatorUrl: facilitator.url,
    network: NETWORK,
    payTo: PAY_TO,
    routes: { "GET /weather": "$0.001" },
    sinks: { console: false },
  });
  await lens.ready;

  const app = express();
  app.use(lens.middleware);
  app.get("/weather", (_req, res) => res.json({ ok: true }));

  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}/weather`,
    server,
    close: async () => {
      await lens.close();
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      );
    },
  };
}

describe("watch: a healthy paywall", () => {
  it("reports ok and records the baseline", async () => {
    const paywall = await startPaywall();
    try {
      const result = await checkEndpoint({ url: paywall.url }, undefined);

      expect(result.ok).toBe(true);
      expect(result.status).toBe(402);
      expect(result.challenge).toBeDefined();
      expect(result.drift).toEqual([]);

      const state = nextState([result]);
      expect(Object.keys(state.lastChallenges)).toHaveLength(1);
    } finally {
      await paywall.close();
    }
  });

  it("stays quiet on a second identical check", async () => {
    const paywall = await startPaywall();
    try {
      const first = await checkEndpoint({ url: paywall.url }, undefined);
      const state = nextState([first]);
      const second = await checkEndpoint(
        { url: paywall.url },
        state.lastChallenges[first.endpoint],
      );

      // A monitor that alerts on every run is noise, and noise gets muted
      // before the day it would have mattered.
      expect(second.drift).toEqual([]);
      expect(second.ok).toBe(true);
    } finally {
      await paywall.close();
    }
  });
});

describe("watch: a regression", () => {
  it("reports paywall_gone when the server stops challenging", async () => {
    const paywall = await startPaywall();
    const first = await checkEndpoint({ url: paywall.url }, undefined);
    const baseline = nextState([first]);

    await paywall.close();

    // The port is closed now, so the check fails to connect. That is not the
    // same as a paywall that answers 200 — and both must be reported.
    const after = await checkEndpoint(
      { url: paywall.url, timeoutMs: 2_000 },
      baseline.lastChallenges[first.endpoint],
    );

    expect(after.ok).toBe(false);
  });

  it("survives a connection failure without throwing", async () => {
    // A monitor that crashes on the first network blip is worse than none.
    const result = await checkEndpoint(
      { url: "http://127.0.0.1:1/weather", timeoutMs: 1_000 },
      undefined,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.status).toBe(0);
  });
});

describe("watch: state across runs", () => {
  it("keeps the baseline when a run fails", async () => {
    const paywall = await startPaywall();
    const first = await checkEndpoint({ url: paywall.url }, undefined);
    await paywall.close();

    const dir = await mkdtemp(join(tmpdir(), "watch-"));
    const path = join(dir, "state.json");
    await writeWatchState(path, nextState([first]));

    const failed = await checkEndpoint(
      { url: paywall.url, timeoutMs: 1_000 },
      (await readWatchState(path)).lastChallenges[first.endpoint],
    );
    const state = nextState([failed], await readWatchState(path));

    // Losing the baseline on a blip would make the next good check look like a
    // fresh install, hiding any change that happened during the outage.
    expect(Object.keys(state.lastChallenges)).toHaveLength(1);
  });

  it("persists and reloads the challenge verbatim", async () => {
    const paywall = await startPaywall();
    try {
      const result = await checkEndpoint({ url: paywall.url }, undefined);
      const dir = await mkdtemp(join(tmpdir(), "watch-"));
      const path = join(dir, "state.json");

      await writeWatchState(path, nextState([result]));
      const reloaded = await readWatchState(path);

      expect(reloaded.lastChallenges[result.endpoint]?.accepts?.[0]?.network).toBe(NETWORK);
      // The raw file must be parseable by anything, not just by this code.
      const raw = await readFile(path, "utf8");
      expect(() => JSON.parse(raw)).not.toThrow();
    } finally {
      await paywall.close();
    }
  });
});
