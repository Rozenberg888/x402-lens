/**
 * `x402-lens` command line entry point.
 *
 * Every command exits non-zero when something is wrong, so CI can gate on it.
 */

import { AddError, addProtection } from "./commands/add.js";
import { explainPayment } from "./commands/explain.js";
import { runDoctor } from "./commands/doctor.js";
import { inspectEndpoint } from "./commands/inspect.js";
import { reconcileTransaction } from "./commands/reconcile.js";
import { flagEnabled, flagValue, parseArgs } from "./args.js";
import { InputError } from "./input.js";

const USAGE = `x402-lens — explain and verify x402 v2 payments

Usage:
  x402-lens inspect <url> [--method GET] [--header "K: V"] [--timeout 15000]
      Fetch an endpoint unpaid, decode PAYMENT-REQUIRED, and report schema
      conformance and CORS readiness for browser buyers.

  x402-lens explain [--challenge <b64|json|@file>] [--payment <...>]
                    [--verify <...>] [--settle <...>]
      Diagnose a failed exchange: what is wrong, and what to change.

  x402-lens doctor [--facilitator <url>] [--network <caip2>] [--networks <a,b>]
      Verify that configuration can actually accept payments, including that
      the facilitator supports every configured network with x402Version 2.

  x402-lens reconcile --tx <hash> [--network <caip2>] [--rpc <url>]
      Check whether a settlement transaction confirmed on chain. Use this
      after settlement_pending — never retry a payment until you know.

  x402-lens add "<METHOD> <path>" --file <path> --price <amount> [--write]
      Add x402 protection to an existing Express route. Prints a diff unless
      --write is passed.

Options:
  --help, -h    Show this help.

Exit codes:
  0  success
  1  a check failed or a finding is an error
  2  bad usage
`;

/**
 * Run the CLI.
 *
 * @param argv - Arguments after the script path
 * @returns Process exit code
 */
export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  if (flagEnabled(args, "help") || flagEnabled(args, "h") || args.command === undefined) {
    process.stdout.write(USAGE);
    return args.command === undefined && !flagEnabled(args, "help") && !flagEnabled(args, "h")
      ? 2
      : 0;
  }

  try {
    switch (args.command) {
      case "inspect": {
        const url = args.positionals[0];
        if (!url) {
          process.stderr.write("inspect requires a URL.\n\n" + USAGE);
          return 2;
        }
        const result = await inspectEndpoint({
          url,
          ...(flagValue(args, "method") ? { method: flagValue(args, "method") as string } : {}),
          ...(flagValue(args, "header")
            ? { headers: parseHeaderFlags(argv) }
            : {}),
          ...(flagValue(args, "timeout")
            ? { timeoutMs: Number.parseInt(flagValue(args, "timeout") as string, 10) }
            : {}),
        });
        process.stdout.write(`${result.findings}\n`);
        return result.exitCode;
      }

      case "explain": {
        const result = await explainPayment({
          ...(flagValue(args, "challenge") ? { challenge: flagValue(args, "challenge") as string } : {}),
          ...(flagValue(args, "payment") ? { payment: flagValue(args, "payment") as string } : {}),
          ...(flagValue(args, "verify") ? { verify: flagValue(args, "verify") as string } : {}),
          ...(flagValue(args, "settle") ? { settle: flagValue(args, "settle") as string } : {}),
        });
        process.stdout.write(`${result.text}\n`);
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
        process.stdout.write(`${result.text}\n`);
        return result.exitCode;
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
        process.stdout.write(`${result.text}\n`);
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
 * `--header` may repeat; `parseArgs` only keeps the last. Re-scan argv for all
 * occurrences so `inspect` can send several headers.
 */
function parseHeaderFlags(argv: string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--header") continue;
    const value = argv[index + 1];
    if (!value) continue;
    const separator = value.indexOf(":");
    if (separator === -1) continue;
    headers[value.slice(0, separator).trim()] = value.slice(separator + 1).trim();
    index += 1;
  }
  return headers;
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
      process.stderr.write(`Unexpected error: ${(error as Error).message}\n`);
      process.exitCode = 1;
    });
}
