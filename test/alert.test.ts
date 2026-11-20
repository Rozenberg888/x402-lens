/**
 * Alerting: what a monitor says when it wakes you up.
 *
 * Two things matter and both are tested here. First, the text has to name the
 * endpoint and what breaks, because it is read on a phone at 3am. Second, a
 * broken channel must not break the monitor: a revoked webhook cannot stop the
 * checks from running, or the outage that matters goes unreported twice.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { formatAlert, sendAlert, type AlertChannel } from "../packages/cli/src/commands/alert.js";
import type { WatchResult } from "../packages/cli/src/commands/watch.js";

/** Results shaped like the ones `checkEndpoint` produces. */
function healthy(endpoint = "GET https://api.example/weather"): WatchResult {
  return { endpoint, ok: true, status: 402, drift: [] };
}

function drifted(
  kind: WatchResult["drift"][number]["kind"],
  endpoint = "GET https://api.example/weather",
): WatchResult {
  // Detail text as `diffChallenges` writes it, so the alert is tested against
  // realistic input rather than a placeholder that hides formatting bugs.
  const detail =
    kind === "network_removed"
      ? "Payment option exact@eip155:8453 is no longer offered. Clients paying on it will start failing."
      : kind === "pay_to_changed"
        ? "exact@eip155:84532: payTo changed from 0xaaa to 0xbbb."
        : `${kind} on ${endpoint}`;

  return {
    endpoint,
    ok: false,
    status: 402,
    drift: [{ kind, endpoint, detail }],
  };
}

function unreachable(endpoint = "GET https://api.example/weather"): WatchResult {
  return { endpoint, ok: false, status: 0, drift: [], error: "ECONNREFUSED" };
}

describe("formatAlert", () => {
  it("names the endpoint and counts the failures", () => {
    const { text } = formatAlert([drifted("network_removed")], 3);

    expect(text).toContain("1 of 3 endpoint(s) need attention");
    expect(text).toContain("GET https://api.example/weather");
  });

  it("explains what a client loses, not just what changed", () => {
    const removed = formatAlert([drifted("network_removed")], 1);
    // Someone woken up needs "clients on it start failing", not
    // "network_removed".
    expect(removed.text).toContain("no longer offered");

    const payTo = formatAlert([drifted("pay_to_changed")], 1);
    expect(payTo.text).toContain("different address");
  });

  it("reports a paywall that disappeared in plain language", () => {
    const { text } = formatAlert([drifted("paywall_gone")], 1);
    expect(text).toContain("Paywall is gone");
  });

  it("includes the connection error when an endpoint is unreachable", () => {
    const { text } = formatAlert([unreachable()], 1);
    expect(text).toContain("ECONNREFUSED");
    // Status 0 has no meaning to a reader; "no response" does.
    expect(text).toContain("no response");
  });

  it("says so when an endpoint answered but returned nothing readable", () => {
    const result: WatchResult = {
      endpoint: "GET https://api.example/x",
      ok: false,
      status: 200,
      drift: [],
    };
    expect(formatAlert([result], 1).text).toContain("No x402 challenge returned");
  });

  it("summarises the ratio for a subject line", () => {
    expect(formatAlert([drifted("paywall_gone"), unreachable()], 5).summary).toBe("2/5 failing");
  });

  it("leaves a healthy endpoint out of the text", () => {
    const { text } = formatAlert([healthy(), drifted("paywall_gone")], 2);

    // The healthy one is context, not content: including it would bury the
    // thing that broke.
    expect(text).toContain("1 of 2");
    expect(text).not.toContain("HTTP 402\n• HTTP");
  });
});

describe("sendAlert: channel not configured", () => {
  it("reports why it did not send instead of throwing", async () => {
    const result = await sendAlert({}, [drifted("paywall_gone")], 1);

    expect(result.sent).toBe(false);
    expect(result.reason).toContain("no slackWebhookUrl");
  });
});

describe("sendAlert: nothing to report", () => {
  it("stays silent on success by default", async () => {
    // A monitor that posts "all good" every minute gets its channel muted, and
    // then the real alert is missed too.
    const result = await sendAlert({ slackWebhookUrl: "https://example.invalid/hook" }, [], 3);

    expect(result.sent).toBe(false);
    expect(result.reason).toBe("nothing to report");
  });
});

describe("sendAlert: delivery", () => {
  let server: Server;
  let webhookUrl: string;
  const received: Array<{ body: string; contentType: string | undefined }> = [];
  let respondWith = { status: 200, body: "ok" };

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        received.push({
          body: Buffer.concat(chunks).toString("utf8"),
          contentType: request.headers["content-type"],
        });
        response.writeHead(respondWith.status, { "content-type": "text/plain" });
        response.end(respondWith.body);
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    webhookUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    );
  });

  it("posts the alert text as JSON", async () => {
    received.length = 0;
    respondWith = { status: 200, body: "ok" };

    const channel: AlertChannel = { slackWebhookUrl: webhookUrl };
    const result = await sendAlert(channel, [drifted("network_removed")], 2);

    expect(result.sent).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0]?.contentType).toContain("application/json");

    const payload = JSON.parse(received[0]?.body ?? "{}") as { text?: string };
    expect(payload.text).toContain("need attention");
  });

  it("reports the Slack status when the webhook rejects the message", async () => {
    received.length = 0;
    respondWith = { status: 404, body: "no_service" };

    const result = await sendAlert({ slackWebhookUrl: webhookUrl }, [drifted("paywall_gone")], 1);

    // A revoked webhook is the most common failure, and its body says so — that
    // is more actionable than "delivery failed".
    expect(result.sent).toBe(false);
    expect(result.reason).toContain("404");
    expect(result.reason).toContain("no_service");
  });

  it("reports an unreachable webhook without throwing", async () => {
    // Port 1 refuses immediately. The monitor must survive a dead channel.
    const result = await sendAlert(
      { slackWebhookUrl: "http://127.0.0.1:1/hook" },
      [drifted("paywall_gone")],
      1,
    );

    expect(result.sent).toBe(false);
    expect(result.reason).toContain("could not reach Slack");
  });

  it("posts on success when explicitly asked", async () => {
    received.length = 0;
    respondWith = { status: 200, body: "ok" };

    const result = await sendAlert({ slackWebhookUrl: webhookUrl, onSuccess: true }, [], 4);

    // The option exists to prove a new channel works, once.
    expect(result.sent).toBe(true);
    expect(received).toHaveLength(1);
  });
});
