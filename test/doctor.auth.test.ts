/**
 * `doctor` on a facilitator that requires credentials.
 *
 * CDP's facilitator answers 401 without an API key, and that is the first thing
 * a CDP user hits. The previous behaviour reported it as
 * "facilitator reachable: FAIL" and then "Fix the FAIL lines above" — both
 * wrong, and both sending the operator to check the URL and the network, where
 * nothing is broken. There is nothing to fix by editing config; a credential has
 * to be obtained.
 *
 * This is the same class of mistake as the `server.register(...)` advice already
 * fixed: an error message that describes a problem the reader cannot act on.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { runDoctor } from "../packages/cli/src/commands/doctor.js";

const NETWORK = "eip155:84532";

let server: Server;
let baseUrl: string;
/** Status the `/supported` endpoint answers with. */
let status = 200;
/** Body returned alongside a non-200 status. */
let body = "unauthorized";

beforeAll(async () => {
  server = createServer((request, response) => {
    if (status !== 200) {
      response.writeHead(status, { "content-type": "text/plain" });
      response.end(body);
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }],
      }),
    );
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close(error => (error ? reject(error) : resolve())),
  );
});

describe("doctor: facilitator requires credentials", () => {
  it("reports an auth check, not a reachability failure", async () => {
    status = 401;
    const result = await runDoctor({ facilitatorUrl: baseUrl, network: NETWORK });

    const failed = result.checks.filter(check => !check.ok);
    // Naming it "reachable: false" is what made the message misleading: the
    // facilitator answered, promptly, with a specific refusal.
    expect(failed[0]?.name).toBe("facilitator auth");
    expect(result.checks.some(check => check.name === "facilitator reachable")).toBe(false);
  });

  it("says the facilitator is up and what to configure", async () => {
    status = 401;
    const result = await runDoctor({ facilitatorUrl: baseUrl, network: NETWORK });

    const detail = result.checks.find(check => check.name === "facilitator auth")?.detail ?? "";
    expect(detail).toContain("is up but requires credentials");
    // The actionable part: a field name the user can actually search for.
    expect(detail).toContain("facilitatorHeaders");
  });

  it("does not tell the reader to fix a config mistake that does not exist", async () => {
    status = 401;
    const result = await runDoctor({ facilitatorUrl: baseUrl, network: NETWORK });

    // "Fix the FAIL lines above" implies an edit fixes it. It does not.
    expect(result.text).not.toContain("Fix the FAIL lines");
    expect(result.text).toContain("obtain credentials");
  });

  it("still exits non-zero, because payments will fail until it is fixed", async () => {
    status = 401;
    const result = await runDoctor({ facilitatorUrl: baseUrl, network: NETWORK });

    // The distinction is about the message, not the severity: an endpoint in
    // this state cannot accept payments.
    expect(result.exitCode).toBe(1);
  });

  it("treats 403 the same way", async () => {
    status = 403;
    const result = await runDoctor({ facilitatorUrl: baseUrl, network: NETWORK });

    expect(result.checks.some(check => check.name === "facilitator auth")).toBe(true);
  });
});

describe("doctor: a facilitator that is genuinely down", () => {
  it("keeps the reachability name and the fix-it wording", async () => {
    status = 500;
    const result = await runDoctor({ facilitatorUrl: baseUrl, network: NETWORK });

    // A 5xx is a server fault: the operator cannot obtain a credential for it,
    // and "fix the lines above" is the right framing for a retry/failover.
    expect(result.checks.some(check => check.name === "facilitator reachable")).toBe(true);
    expect(result.checks.some(check => check.name === "facilitator auth")).toBe(false);
    expect(result.text).toContain("Fix the FAIL lines");
    status = 200;
  });
});
