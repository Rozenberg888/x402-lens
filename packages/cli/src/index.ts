/**
 * `x402-lens` command line entry point.
 *
 * Every command exits non-zero when something is wrong, so CI can gate on it.
 */

import { AddError, addProtection } from "./commands/add.js";
import { sendAlert, type AlertChannel } from "./commands/alert.js";
import { explainPayment } from "./commands/explain.js";
import { runDoctor } from "./commands/doctor.js";
import { inspectEndpoint } from "./commands/inspect.js";
import { reconcileTransaction } from "./commands/reconcile.js";
import {
  checkEndpoint,
  endpointKey,
  nextState,
  readWatchState,
  writeWatchState,
  type WatchResult,
  type WatchState,
} from "./commands/watch.js";
import { flagEnabled, flagValue, parseArgs } from "./args.js";
import { InputError } from "./input.js";

const USAGE = `x402-lens — explain and verify x402 v2 payments

Usage:
  x402-lens inspect <url> [--method GET] [--header "K: V"] [--timeout 15000] [--json]
      Fetch an endpoint unpaid, decode PAYMENT-REQUIRED, and report schema
      conformance and CORS readiness for browser buyers.

  x402-lens explain [--challenge <b64|json|@file>] [--payment <...>]
                    [--verify <...>] [--settle <...>] [--json]
      Diagnose a failed exchange: what is wrong, and what to change.

  x402-lens doctor [--facilitator <url>] [--network <caip2>] [--networks <a,b>] [--json]
      Verify that configuration can actually accept payments, including that
      the facilitator supports every configured network with x402Version 2.

  x402-lens reconcile --tx <hash> [--network <caip2>] [--rpc <url>] [--json]
      Check whether a settlement transaction confirmed on chain. Use this
      after settlement_pending — never retry a payment until you know.

  x402-lens watch <url...> [--state <file>] [--interval <seconds>] [--once] [--slack <url>] [--json]
      Monitor paywalls from the outside. Checks that a 402 with a readable
      challenge comes back, and alerts when a network, price, payTo or the CORS
      headers change. No SDK integration needed on the monitored server.
      Runs once by default; --interval repeats until interrupted.
      Alerts go to Slack via --slack or X402_LENS_SLACK_WEBHOOK.

  x402-lens add "<METHOD> <path>" --file <path> --price <amount> [--write]
      Add x402 protection to an existing Express route. Prints a diff unless
      --write is passed.

Options:
  --json        Machine-readable JSON on stdout (inspect / explain / doctor / reconcile / watch)
  --help, -h    Show this help.

Exit codes:
  0  success / confirmed
  1  a check failed, a finding is an error, or the transaction failed on chain
  2  bad usage
  reconcile only, because the safe action differs per state:
  3  not found — nothing broadcast, a fresh payment is safe
  4  pending — on chain, will confirm; retrying would pay twice
  5  unknown — the RPC could not answer; say nothing about retrying
`;

/**
 * Run the CLI.
 *
 * @param argv - Arguments after the script path
 * @returns Process exit code
 */
export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const asJson = flagEnabled(args, "json");

  if (flagEnabled(args, "help") || flagEnabled(args, "h") || args.command === undefined) {
    process.stdout.write(USAGE);
    return args.command === undefined && !flagEnabled(args, "help") && !flagEnabled(args, "h")
      ? 2
      : 0;
  }

  // An argument the parser could not interpret is bad usage, not a failed check.
  // Silently ignoring it was how `--timeoutt 5` ran with the default timeout and
  // still exited 0, leaving the user to think their flag took effect.
  if (args.errors.length > 0) {
    const message = args.errors.join("\n");
    if (asJson) {
      process.stdout.write(`${JSON.stringify({ error: message, exitCode: 2 }, null, 2)}\n`);
    } else {
      process.stderr.write(`${message}\n\n${USAGE}`);
    }
    return 2;
  }

  try {
    switch (args.command) {
      case "inspect": {
        const url = args.positionals[0];
        if (!url) {
          process.stderr.write("inspect requires a URL.\n\n" + USAGE);
          return 2;
        }

        const timeout = parseTimeout(flagValue(args, "timeout"));
        if (timeout.error) {
          process.stderr.write(`${timeout.error}\n`);
          return 2;
        }
        const headerFlags = parseHeaderFlags(argv);
        if (headerFlags.errors.length > 0) {
          process.stderr.write(`${headerFlags.errors.join("\n")}\n`);
          return 2;
        }

        let result: Awaited<ReturnType<typeof inspectEndpoint>>;
        try {
          result = await inspectEndpoint({
            url,
            ...(flagValue(args, "method") ? { method: flagValue(args, "method") as string } : {}),
            ...(Object.keys(headerFlags.headers).length > 0
              ? { headers: headerFlags.headers }
              : {}),
            ...(timeout.value !== undefined ? { timeoutMs: timeout.value } : {}),
          });
        } catch (error) {
          // `fetch` throws before any response exists: a malformed URL, a DNS
          // failure, a refused connection. Letting it reach the top-level handler
          // produced "Unexpected error: Failed to parse URL from …" on stderr and
          // nothing on stdout — which breaks the `--json` contract (machine
          // readers got an empty stream) and tells a human nothing about which
          // argument was wrong. `doctor` and `watch` already wrap this; inspect
          // was the one that did not.
          const asError = error instanceof Error ? error : new Error(String(error));
          const message = /Failed to parse URL/i.test(asError.message)
            ? `"${url}" is not a valid URL. Include the scheme, for example https://api.example.com/weather.`
            : `Could not reach ${url}: ${asError.message}`;
          if (asJson) {
            process.stdout.write(
              `${JSON.stringify({ status: 0, error: message, exitCode: 1 }, null, 2)}\n`,
            );
          } else {
            process.stderr.write(`${message}\n`);
          }
          return 1;
        }
        if (asJson) {
          process.stdout.write(
            `${JSON.stringify(
              {
                status: result.status,
                headerPresent: result.headerPresent,
                decodedFromBody: result.decodedFromBody,
                paymentRequired: result.paymentRequired ?? null,
                conformance: result.conformance,
                cors: result.cors,
                exitCode: result.exitCode,
              },
              null,
              2,
            )}\n`,
          );
        } else {
          process.stdout.write(`${result.findings}\n`);
        }
        return result.exitCode;
      }

      case "explain": {
        const result = await explainPayment({
          ...(flagValue(args, "challenge") ? { challenge: flagValue(args, "challenge") as string } : {}),
          ...(flagValue(args, "payment") ? { payment: flagValue(args, "payment") as string } : {}),
          ...(flagValue(args, "verify") ? { verify: flagValue(args, "verify") as string } : {}),
          ...(flagValue(args, "settle") ? { settle: flagValue(args, "settle") as string } : {}),
        });
        if (asJson) {
          process.stdout.write(
            `${JSON.stringify(
              {
                findings: result.findings,
                findingCount: result.findingCount,
                exitCode: result.exitCode,
              },
              null,
              2,
            )}\n`,
          );
        } else {
          process.stdout.write(`${result.text}\n`);
        }
        return result.exitCode;
      }

      case "doctor": {
        const networksFlag = flagValue(args, "networks");
        const result = await runDoctor({
          ...(flagValue(args, "facilitator")
            ? { facilitatorUrl: flagValue(args, "facilitator") as string }
            : {}),
          ...(flagValue(args, "network") ? { network: flagValue(args, "network") as string } : {}),
          ...(networksFlag
            ? {
                networks: networksFlag
                  .split(",")
                  .map(part => part.trim())
                  .filter(Boolean),
              }
            : {}),
        });
        if (asJson) {
          process.stdout.write(
            `${JSON.stringify(
              {
                checks: result.checks,
                exitCode: result.exitCode,
              },
              null,
              2,
            )}\n`,
          );
        } else {
          process.stdout.write(`${result.text}\n`);
        }
        return result.exitCode;
      }

      case "watch": {
        const urls = args.positionals;
        if (urls.length === 0) {
          process.stderr.write("watch requires at least one URL.\n\n" + USAGE);
          return 2;
        }

        const statePath = flagValue(args, "state");
        const interval = parseInterval(flagValue(args, "interval"));
        if (interval.error) {
          process.stderr.write(`${interval.error}\n`);
          return 2;
        }
        const intervalSeconds = interval.value;
        // `--once` and "no interval" mean the same thing. Reading the flag at
        // all matters: it was documented in the usage text and never consulted,
        // so `watch --once <url>` only worked by accident.
        const once = flagEnabled(args, "once") || intervalSeconds === undefined;

        // Worst exit code seen across runs, so an interrupted or long-running
        // monitor reports failure if any check ever failed.
        let lastExitCode = 0;

        // Slack webhook from the flag or the environment. It is a credential, so
        // the environment is the expected source; the flag exists for a one-off
        // check without exporting anything.
        const slackWebhookUrl =
          flagValue(args, "slack") ?? process.env.X402_LENS_SLACK_WEBHOOK;
        const channel: AlertChannel = {
          ...(slackWebhookUrl ? { slackWebhookUrl } : {}),
          ...(flagEnabled(args, "alert-on-success") ? { onSuccess: true } : {}),
        };

        // Previous challenges are the whole point: without them every check is
        // "is there a 402", which an uptime monitor already answers.
        let state: WatchState = { lastChallenges: {} };
        if (statePath) {
          state = await readWatchState(statePath);
        }

        const runOnce = async (): Promise<number> => {
          const results: WatchResult[] = [];
          for (const url of urls) {
            results.push(
              await checkEndpoint(
                { url },
                state.lastChallenges[endpointKey({ url })],
              ),
            );
          }
          state = nextState(results, state);
          if (statePath) await writeWatchState(statePath, state);

          const drifted = results.filter(result => result.drift.length > 0);
          const failed = results.filter(result => !result.ok);
          const needsAttention = results.filter(
            result => !result.ok || result.drift.length > 0,
          );

          const alert = await sendAlert(channel, needsAttention, results.length);

          if (asJson) {
            const document = {
              results,
              drifted: drifted.length,
              failed: failed.length,
              alert: alert.sent ? { sent: true } : { sent: false, reason: alert.reason },
            };
            // In repeating mode this is one document per line, so the stream is
            // NDJSON and a consumer can parse it incrementally. Pretty-printing
            // each run produced concatenated multi-line documents, which no
            // streaming parser accepts and `JSON.parse` of the whole stream
            // rejects — the usage text calls `--json` "machine-readable", and a
            // stream that cannot be read is not.
            process.stdout.write(
              once ? `${JSON.stringify(document, null, 2)}\n` : `${JSON.stringify(document)}\n`,
            );
          } else {
            for (const result of results) {
              const mark = result.ok ? "ok  " : "FAIL";
              process.stdout.write(
                `${mark} ${result.endpoint} → HTTP ${result.status}${result.error ? ` (${result.error})` : ""}\n`,
              );
              for (const item of result.drift) {
                process.stdout.write(`     ${item.kind}: ${item.detail}\n`);
              }
            }
            // Say so when an alert could not be delivered: a monitor whose
            // channel is broken looks identical to a healthy one otherwise.
            if (slackWebhookUrl && !alert.sent && alert.reason !== "nothing to report") {
              process.stderr.write(`alert not delivered: ${alert.reason}\n`);
            }
          }

          return failed.length > 0 || drifted.length > 0 ? 1 : 0;
        };

        if (once) return await runOnce();

        // Repeating mode: run until interrupted. Kept simple deliberately — a
        // scheduler belongs in cron or a process manager, not in this loop.
        //
        // SIGINT still has to be handled: without it, Ctrl+C kills the process
        // wherever it happens to be, which can be mid-write of the state file.
        // The write is atomic (temp file plus rename), so a truncated state file
        // is not the risk — the risk is that the operator gets no confirmation
        // and no chance to see the last result. Stopping between checks is what
        // makes the loop's lifetime predictable.
        let stopping = false;
        const onSignal = (): void => {
          stopping = true;
        };
        process.once("SIGINT", onSignal);
        process.once("SIGTERM", onSignal);

        try {
          while (!stopping) {
            const code = await runOnce();
            // Record the worst outcome seen, so an interrupted monitor still
            // exits non-zero if any check failed before the signal.
            if (code !== 0) lastExitCode = code;
            if (stopping) break;
            await new Promise<void>(resolve => {
              const timer = setTimeout(done, intervalSeconds * 1000);

              // Wake immediately on a signal instead of waiting out the
              // interval. Both listeners are removed on whichever path runs
              // first: leaving them registered accumulated one SIGINT listener
              // per cycle (Node warns at 11), so a monitor on a 30 s interval
              // grew thousands of them per day and every Ctrl+C fired all the
              // stale closures.
              function done(): void {
                clearTimeout(timer);
                process.off("SIGINT", done);
                process.off("SIGTERM", done);
                resolve();
              }
              process.once("SIGINT", done);
              process.once("SIGTERM", done);
            });
          }
        } finally {
          process.off("SIGINT", onSignal);
          process.off("SIGTERM", onSignal);
        }

        return lastExitCode;
      }

      case "add": {
        const route = args.positionals[0];
        const file = flagValue(args, "file");
        const price = flagValue(args, "price");
        if (!route || !file || !price) {
          process.stderr.write(
            'add requires a route, --file, and --price. Example:\n  x402-lens add "GET /weather" --file src/server.ts --price 0.001\n',
          );
          return 2;
        }
        const result = await addProtection({
          file,
          route,
          price,
          write: flagEnabled(args, "write"),
        });
        process.stdout.write(`${result.text}\n`);
        return result.exitCode;
      }

      case "reconcile": {
        const tx = flagValue(args, "tx") ?? args.positionals[0];
        if (!tx) {
          process.stderr.write(
            "reconcile requires --tx <hash>. Example:\n  x402-lens reconcile --tx 0xabc… --network eip155:84532\n",
          );
          return 2;
        }
        const result = await reconcileTransaction({
          tx,
          ...(flagValue(args, "network")
            ? { network: flagValue(args, "network") as string }
            : {}),
          ...(flagValue(args, "rpc") ? { rpcUrl: flagValue(args, "rpc") as string } : {}),
          ...(flagValue(args, "timeout")
            ? { timeoutMs: Number.parseInt(flagValue(args, "timeout") as string, 10) }
            : {}),
        });
        if (asJson) {
          process.stdout.write(
            `${JSON.stringify(
              {
                status: result.status,
                network: result.network,
                tx: result.tx,
                rpcUrl: result.rpcUrl,
                block: result.block ?? null,
                detail: result.detail,
                exitCode: result.exitCode,
              },
              null,
              2,
            )}\n`,
          );
        } else {
          process.stdout.write(`${result.text}\n`);
        }
        return result.exitCode;
      }

      default:
        process.stderr.write(`Unknown command "${args.command}".\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof InputError || error instanceof AddError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
}

/**
 * Validate `--timeout` as a positive integer of milliseconds.
 *
 * `Number.parseInt` with no check was passed straight to `AbortSignal.timeout`,
 * which throws `RangeError` for `NaN` and negatives. That throw was caught by the
 * network-error handler and reported as "Could not reach <url>: The value of
 * "delay" is out of range" — blaming the endpoint for a locally invalid argument,
 * with exit 1 (a failed check) instead of 2 (bad usage).
 *
 * @param raw - Flag value, if given
 * @returns Parsed value, or an error message
 */
function parseTimeout(raw: string | undefined): { value?: number; error?: string } {
  if (raw === undefined) return {};
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
    return { error: `--timeout must be a positive integer number of milliseconds, got "${raw}".` };
  }
  return { value: Number(raw) };
}

/**
 * Validate `--interval` as a positive number of seconds.
 *
 * Node clamps a `setTimeout` delay above 2^23-1 ms (about 24.8 days) to 1 ms, so
 * `--interval 3000000` became a ~1 ms poll loop: 330 requests to the monitored
 * endpoint in 7 seconds, plus a `TimeoutOverflowWarning`. The ceiling is enforced
 * here rather than left to the runtime.
 *
 * @param raw - Flag value, if given
 * @returns Parsed value, or an error message
 */
function parseInterval(raw: string | undefined): { value?: number; error?: string } {
  if (raw === undefined) return {};
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
    return { error: `--interval must be a positive number of seconds, got "${raw}".` };
  }
  const seconds = Number(raw);
  // 2_147_483 ms is the largest delay setTimeout honours; stay under it.
  if (seconds * 1000 > 2_147_483) {
    return {
      error: `--interval must be at most ${Math.floor(2_147_483 / 1000)} seconds; larger values are clamped by Node to a 1 ms delay, which turns the monitor into a request flood.`,
    };
  }
  return { value: seconds };
}

/**
 * Collect every `--header` occurrence, in both spellings.
 *
 * `parseArgs` keeps one value per flag, and `--header` is the one flag that must
 * repeat: inspecting an authenticated endpoint needs several. The previous
 * version re-scanned `argv` for the exact token `"--header"`, so
 * `--header="Authorization: Bearer …"` — the spelling `parseArgs` supports —
 * was silently dropped, and the request went out unauthenticated while the user
 * saw a 401 and blamed their token.
 *
 * A value without a `:` is a usage error rather than a silent skip: dropping it
 * means sending a request the user did not describe.
 *
 * @param argv - Raw arguments, scanned for repeats
 * @returns Headers to send, plus any header that could not be parsed
 */
function parseHeaderFlags(argv: string[]): {
  headers: Record<string, string>;
  errors: string[];
} {
  const headers: Record<string, string> = {};
  const errors: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;

    let value: string | undefined;
    if (token === "--header") {
      value = argv[index + 1];
      index += 1;
    } else if (token.startsWith("--header=")) {
      value = token.slice("--header=".length);
    } else {
      continue;
    }

    if (value === undefined || value.length === 0) {
      errors.push('--header requires a value such as "Authorization: Bearer …".');
      continue;
    }
    const separator = value.indexOf(":");
    if (separator === -1) {
      errors.push(`--header "${value}" has no colon. Use "Name: value".`);
      continue;
    }
    const name = value.slice(0, separator).trim();
    if (name.length === 0) {
      errors.push(`--header "${value}" has no name before the colon.`);
      continue;
    }
    headers[name] = value.slice(separator + 1).trim();
  }

  return { headers, errors };
}

const isDirectRun =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("x402-lens") || process.argv[1].endsWith("index.js"));

if (isDirectRun) {
  main(process.argv.slice(2))
    .then(code => {
      process.exitCode = code;
    })
    .catch(error => {
      // A bug in this CLI, not a user mistake. It still has to honour `--json`:
      // a machine reader that gets a human sentence on stderr and an empty
      // stdout cannot tell this apart from success.
      const message = (error as Error).message;
      if (process.argv.includes("--json")) {
        process.stdout.write(`${JSON.stringify({ error: message, exitCode: 1 }, null, 2)}\n`);
      } else {
        process.stderr.write(`Unexpected error: ${message}\n`);
      }
      process.exitCode = 1;
    });
}
