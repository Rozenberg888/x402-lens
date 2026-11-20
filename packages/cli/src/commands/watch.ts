/**
 * `x402-lens watch` — synthetic monitoring for an x402 paywall.
 *
 * Everything here works from the outside. The endpoint owner changes no code and
 * installs no SDK; they give a URL and this checks it. That is the point: a
 * paywall can break in ways the application never notices — the challenge stops
 * being issued, a network disappears from `accepts`, CORS regresses, a proxy
 * starts answering 502 — and none of those throw inside the app.
 *
 * The interesting part is not "is it up". It is {@link diffChallenges}: a
 * paywall that still returns 402 but now offers a different network is broken
 * for every client that was paying on the old one, and an uptime check alone
 * would call that healthy.
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import {
  type WirePaymentRequired,
  type WirePaymentRequirements,
} from "@x402-lens/core";
import { inspectEndpoint } from "./inspect.js";

/** One endpoint being watched. */
export interface WatchedEndpoint {
  /** URL to request. */
  url: string;
  /** HTTP method. Defaults to `GET`. */
  method?: string;
  /** Extra request headers. */
  headers?: Record<string, string>;
  /** Per-check timeout. Defaults to 15s. */
  timeoutMs?: number;
  /**
   * Label for alerts. Defaults to `"<METHOD> <url>"`.
   *
   * Two endpoints can share a URL with different methods, so the default would
   * be ambiguous in an alert.
   */
  name?: string;
}

/** What changed between two observed challenges. */
export interface ChallengeDrift {
  /** Short machine-readable kind, safe to filter on. */
  kind:
    | "paywall_gone"
    | "challenge_unreadable"
    | "network_removed"
    | "network_added"
    | "scheme_changed"
    | "pay_to_changed"
    | "asset_changed"
    | "amount_increased";
  /** Endpoint label. */
  endpoint: string;
  /** One line an alert can carry without further formatting. */
  detail: string;
}

/** A single check result. */
export interface WatchResult {
  endpoint: string;
  ok: boolean;
  status: number;
  /** Challenge observed on this check, when there was one. */
  challenge?: WirePaymentRequired;
  drift: ChallengeDrift[];
  /** Non-empty only when the check itself failed to run (DNS, timeout). */
  error?: string;
}

/** Identity of one payment option, for set comparison. */
function optionKey(entry: WirePaymentRequirements): string {
  return `${entry.scheme}@${entry.network}`;
}

/**
 * Compare a challenge against the previous one.
 *
 * Every comparison here answers "would a client that paid successfully before
 * still be able to pay now?" — which is the question a paywall alert must
 * answer, and a status-code check cannot.
 *
 * @param endpoint - Label for the drift entries
 * @param previous - Challenge from the last successful check, if any
 * @param current - Challenge observed now, if any
 * @returns Drift entries, empty when nothing a client depends on changed
 */
export function diffChallenges(
  endpoint: string,
  previous: WirePaymentRequired | undefined,
  current: WirePaymentRequired | undefined,
): ChallengeDrift[] {
  // First ever check: there is no baseline to regress from.
  if (!previous) return [];

  if (!current) {
    return [
      {
        kind: "paywall_gone",
        endpoint,
        detail: "The endpoint answered before but no longer returns an x402 challenge.",
      },
    ];
  }

  const drift: ChallengeDrift[] = [];
  const before = previous.accepts ?? [];
  const after = current.accepts ?? [];

  const beforeKeys = new Map(before.map(entry => [optionKey(entry), entry]));
  const afterKeys = new Map(after.map(entry => [optionKey(entry), entry]));

  for (const [key, entry] of beforeKeys) {
    const now = afterKeys.get(key);
    if (!now) {
      drift.push({
        kind: "network_removed",
        endpoint,
        detail: `Payment option ${key} is no longer offered. Clients paying on it will start failing.`,
      });
      continue;
    }

    // The recipient changing silently redirects money, so it is drift even
    // though both values are valid addresses.
    if (entry.payTo !== now.payTo) {
      drift.push({
        kind: "pay_to_changed",
        endpoint,
        detail: `${key}: payTo changed from ${entry.payTo} to ${now.payTo}.`,
      });
    }

    if (entry.asset !== now.asset) {
      drift.push({
        kind: "asset_changed",
        endpoint,
        detail: `${key}: asset changed from ${entry.asset} to ${now.asset}.`,
      });
    }

    if (entry.amount !== now.amount) {
      // A price change is drift in either direction: down breaks nobody, but an
      // alert that suppressed it would also suppress the next change back up.
      drift.push({
        kind: "amount_increased",
        endpoint,
        detail: `${key}: price changed from ${entry.amount} to ${now.amount} atomic units.`,
      });
    }
  }

  for (const key of afterKeys.keys()) {
    if (!beforeKeys.has(key)) {
      drift.push({
        kind: "network_added",
        endpoint,
        detail: `Payment option ${key} is newly offered.`,
      });
    }
  }

  if (drift.length === 0 && optionKey(before[0] ?? ({} as WirePaymentRequirements)) !== optionKey(after[0] ?? ({} as WirePaymentRequirements))) {
    // The set is the same but the primary offer moved, which changes what a
    // client that reads accepts[0] will pay with.
    drift.push({
      kind: "scheme_changed",
      endpoint,
      detail: `The first offered option changed from ${optionKey(before[0] ?? ({} as WirePaymentRequirements))} to ${optionKey(after[0] ?? ({} as WirePaymentRequirements))}.`,
    });
  }

  return drift;
}

/**
 * Check one endpoint and compare it against its previous challenge.
 *
 * Never throws: a DNS failure is a result with `ok: false`, because a monitor
 * that crashes on the first network blip is worse than no monitor.
 *
 * @param target - Endpoint to check
 * @param previous - Challenge from the last successful check
 * @returns Result plus any drift
 */
export async function checkEndpoint(
  target: WatchedEndpoint,
  previous: WirePaymentRequired | undefined,
): Promise<WatchResult> {
  const endpoint = target.name ?? `${target.method ?? "GET"} ${target.url}`;

  let inspected: Awaited<ReturnType<typeof inspectEndpoint>>;
  try {
    inspected = await inspectEndpoint({
      url: target.url,
      ...(target.method ? { method: target.method } : {}),
      ...(target.headers ? { headers: target.headers } : {}),
      ...(target.timeoutMs ? { timeoutMs: target.timeoutMs } : {}),
    });
  } catch (error) {
    const asError = error instanceof Error ? error : new Error(String(error));
    return {
      endpoint,
      ok: false,
      status: 0,
      drift: [],
      error: asError.message,
    };
  }

  const challenge = inspected.paymentRequired;
  const drift = diffChallenges(endpoint, previous, challenge);

  // CORS is deliberately not part of the drift check.
  //
  // A paywall can be correctly configured for server-to-server clients and have
  // no CORS at all — that is a valid deployment, not a regression. Reporting it
  // as drift would alert on the second run of every such endpoint, and an alert
  // that fires when nothing changed is one the operator learns to ignore.
  //
  // `x402-lens inspect` reports CORS readiness on demand, which is the right
  // place for an absolute judgement. Drift here means "something a previously
  // working client depended on has changed", and absence is not a change.

  return {
    endpoint,
    // A paywall is healthy when it answers 402 with a readable challenge and
    // nothing a previous check depended on has changed.
    ok: challenge !== undefined && drift.length === 0,
    status: inspected.status,
    ...(challenge ? { challenge } : {}),
    drift,
  };
}

/** One endpoint's monitoring state across runs. */
export interface WatchState {
  /** Challenge observed on the last run, keyed by endpoint label. */
  lastChallenges: Record<string, WirePaymentRequired>;
}

/** Build the state to persist after a run. */
export function nextState(
  results: WatchResult[],
  previous: WatchState = { lastChallenges: {} },
): WatchState {
  const lastChallenges = { ...previous.lastChallenges };
  for (const result of results) {
    if (result.challenge) lastChallenges[result.endpoint] = result.challenge;
  }
  return { lastChallenges };
}

/**
 * Read previously stored challenges.
 *
 * A missing or unreadable file is not an error: the first run of a monitor has
 * no state, and a corrupted state file must not take the monitor down. Either
 * way the run proceeds with no baseline, which reports "healthy" rather than a
 * false regression.
 *
 * @param path - State file written by a previous run
 * @returns Parsed state, or an empty one
 */
export async function readWatchState(path: string): Promise<WatchState> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<WatchState>;
    if (parsed && typeof parsed === "object" && parsed.lastChallenges && typeof parsed.lastChallenges === "object") {
      return { lastChallenges: parsed.lastChallenges };
    }
    return { lastChallenges: {} };
  } catch {
    return { lastChallenges: {} };
  }
}

/**
 * Persist challenges for the next run.
 *
 * Written atomically through a temporary file: a monitor interrupted mid-write
 * would otherwise leave a truncated JSON file that the next run cannot read,
 * silently losing the baseline.
 *
 * @param path - Where to write
 * @param state - State to persist
 */
export async function writeWatchState(path: string, state: WatchState): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}
