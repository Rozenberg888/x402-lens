/**
 * Alerting for `watch` — the part that makes a monitor a monitor.
 *
 * A check that writes to stdout only helps someone already looking. The value of
 * synthetic monitoring is that it wakes you up when a paywall breaks at 3am,
 * which means the output has to reach somewhere a person reads.
 *
 * Deliberately one channel (Slack incoming webhook) and one format. Anything
 * more is a product decision — PagerDuty, email, repeating until acknowledged —
 * and building it before someone asks is how a weekend MVP becomes a quarter.
 *
 * Failures here are swallowed and returned, never thrown: a broken alert channel
 * must not stop the checks from running and being logged.
 */

import type { ChallengeDrift, WatchResult } from "./watch.js";

/** Where to send alerts. */
export interface AlertChannel {
  /**
   * Slack incoming webhook URL.
   *
   * `https://hooks.slack.com/services/…`. Created in Slack under
   * Apps → Incoming Webhooks; it is a secret, so it belongs in an environment
   * variable, never in a committed config file.
   */
  slackWebhookUrl?: string;
  /**
   * Post even when everything is healthy. Off by default.
   *
   * Useful once to prove the channel works; noise afterwards.
   */
  onSuccess?: boolean;
}

/** Outcome of one delivery attempt. */
export interface AlertResult {
  sent: boolean;
  /** Why it was not sent, or why sending failed. */
  reason?: string;
}

/**
 * Render the alert text.
 *
 * Shape matters more than prose here: a person reads this on a phone. One line
 * per problem, each naming the endpoint and what a client loses.
 *
 * @param failures - Results that need attention
 * @param total - How many endpoints were checked, for context
 * @returns Slack `text` plus a compact summary line
 */
export function formatAlert(
  results: WatchResult[],
  total: number,
): { text: string; summary: string } {
  // Filter rather than trust the caller: a healthy result in this list would
  // inflate the count and produce an alert about nothing.
  const failures = results.filter(result => !result.ok || result.drift.length > 0);
  const withDrift = failures.filter(result => result.drift.length > 0);
  const broken = failures.filter(result => !result.ok && result.drift.length === 0);

  const affected = failures.length;

  const lines: string[] = [];
  lines.push(`x402 paywall check: ${affected} of ${total} endpoint(s) need attention`);

  for (const result of withDrift) {
    lines.push("");
    lines.push(`*${result.endpoint}* — HTTP ${result.status}`);
    for (const item of result.drift) {
      lines.push(`• ${describeDrift(item)}`);
    }
  }

  for (const result of broken) {
    lines.push("");
    lines.push(`*${result.endpoint}* — HTTP ${result.status || "no response"}`);
    lines.push(`• ${result.error ?? "No x402 challenge returned."}`);
  }

  return {
    text: lines.join("\n"),
    summary: `${affected}/${total} failing`,
  };
}

/**
 * One line per drift kind, written for someone woken up by it.
 *
 * @param drift - The change observed
 * @returns A sentence naming what breaks for a client
 */
function describeDrift(drift: ChallengeDrift): string {
  switch (drift.kind) {
    case "paywall_gone":
      return "Paywall is gone: no x402 challenge is returned. Clients will be charged nothing, or fail outright.";
    case "challenge_unreadable":
      return "The PAYMENT-REQUIRED header cannot be decoded, so no client can read the price.";
    case "network_removed":
      return drift.detail;
    case "network_added":
      return drift.detail;
    case "scheme_changed":
      return drift.detail;
    case "pay_to_changed":
      return `${drift.detail} Payments now go to a different address.`;
    case "asset_changed":
      return `${drift.detail} Clients paying the old asset will fail.`;
    case "amount_increased":
      return `${drift.detail} Clients with a spend cap may start refusing.`;
    default: {
      // Exhaustiveness: a new drift kind must be described here, or an alert
      // would arrive with no explanation.
      const unreachable: never = drift.kind;
      return String(unreachable);
    }
  }
}

/**
 * Post an alert to Slack.
 *
 * @param channel - Where to send
 * @param failures - Results needing attention
 * @param total - Endpoints checked this run
 * @returns Whether it was delivered, and why not
 */
export async function sendAlert(
  channel: AlertChannel,
  failures: WatchResult[],
  total: number,
): Promise<AlertResult> {
  if (!channel.slackWebhookUrl) {
    return { sent: false, reason: "no slackWebhookUrl configured" };
  }
  if (failures.length === 0 && !channel.onSuccess) {
    // Staying quiet on success is what makes a failure noticeable.
    return { sent: false, reason: "nothing to report" };
  }

  const { text } = formatAlert(
    failures,
    total,
  );

  try {
    const response = await fetch(channel.slackWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      // Slack answers 200 with a plain `ok` body on success and 4xx with a
      // reason on failure; the body is what tells an operator the webhook was
      // revoked rather than the network being down.
      const body = await response.text().catch(() => "");
      return {
        sent: false,
        reason: `Slack returned HTTP ${response.status}${body ? `: ${body.slice(0, 120)}` : ""}`,
      };
    }

    return { sent: true };
  } catch (error) {
    const asError = error instanceof Error ? error : new Error(String(error));
    return { sent: false, reason: `could not reach Slack: ${asError.message}` };
  }
}
