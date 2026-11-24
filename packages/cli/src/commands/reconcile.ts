/**
 * `x402-lens reconcile` — check whether a settlement transaction actually
 * landed on chain.
 *
 * `settlement_pending` is non-terminal: the facilitator broadcast a tx but
 * could not confirm it. Retrying opens a second payment. This command answers
 * the only safe next question — "is the hash confirmed yet?" — against a public
 * RPC, without needing the SDK or a wallet.
 */

import { describeNetwork, isCaip2, suggestCaip2 } from "@x402-lens/core";

/**
 * Exit codes, distinct per safe action.
 *
 * The command exists to answer "is it safe to retry", and the states need
 * opposite answers:
 *
 * - `0` confirmed: settled, do not charge again.
 * - `1` failed on chain: funds did not move, a fresh payment is safe.
 * - `2` usage error: the arguments are wrong, nothing was checked.
 * - `3` not found: nothing with this hash, so a fresh payment is safe.
 * - `4` pending: on chain, will confirm — a retry would pay twice.
 * - `5` unknown: the RPC could not answer, so say nothing about retrying.
 *
 * `pending` and `not_found` used to share exit 1, which left a script unable to
 * distinguish "do not retry" from "safe to retry" without parsing `--json` —
 * the one distinction this command exists to provide.
 */
const EXIT_CONFIRMED = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const EXIT_NOT_FOUND = 3;
const EXIT_PENDING = 4;
const EXIT_UNKNOWN = 5;

export interface ReconcileOptions {
  /** Transaction hash (`0x…` for EVM, base58 signature for Solana). */
  tx: string;
  /** CAIP-2 network. Defaults to `eip155:84532` (Base Sepolia). */
  network?: string;
  /** Override the RPC URL. When absent, a public endpoint for the network is used. */
  rpcUrl?: string;
  /** Fetch timeout, milliseconds. */
  timeoutMs?: number;
  /** Injected fetch, for tests. */
  fetchImpl?: typeof fetch;
}

export type ReconcileStatus = "confirmed" | "failed" | "pending" | "not_found" | "unknown";

export interface ReconcileResult {
  status: ReconcileStatus;
  network: string;
  tx: string;
  rpcUrl: string;
  /** Block number / slot when known. */
  block?: string;
  /** Raw RPC detail for operators who need more than the status. */
  detail: string;
  exitCode: number;
  text: string;
}

const DEFAULT_RPC: Record<string, string> = {
  "eip155:1": "https://ethereum.publicnode.com",
  "eip155:8453": "https://mainnet.base.org",
  "eip155:84532": "https://sepolia.base.org",
  "eip155:11155111": "https://ethereum-sepolia.publicnode.com",
  // Canonical Base58 form of the Solana mainnet genesis hash, capital `F`. The
  // previous key had a lowercase `v`, so a correct CAIP-2 id missed the table
  // and `reconcile` refused with "No default RPC for Solana mainnet. Pass --rpc"
  // — telling the user to override the one network the table exists to cover —
  // while the misspelt id was accepted and hit mainnet.
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "https://api.mainnet-beta.solana.com",
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": "https://api.devnet.solana.com",
};

/**
 * Ask the chain whether a settlement transaction is confirmed.
 *
 * @param options - Hash, network, and optional RPC override
 * @returns Status, a rendered report, and an exit code (0 = confirmed)
 */
export async function reconcileTransaction(
  options: ReconcileOptions,
): Promise<ReconcileResult> {
  const tx = options.tx.trim();
  if (!tx) {
    return report({
      status: "unknown",
      network: options.network ?? "",
      tx: "",
      rpcUrl: "",
      detail: "No transaction hash was provided.",
      exitCode: 2,
    });
  }

  const network = options.network ?? "eip155:84532";
  if (!isCaip2(network)) {
    const suggestion = suggestCaip2(network);
    return report({
      status: "unknown",
      network,
      tx,
      rpcUrl: "",
      detail: suggestion
        ? `"${network}" is not CAIP-2. Use "${suggestion}".`
        : `"${network}" is not a CAIP-2 network id.`,
      exitCode: 2,
    });
  }

  const rpcUrl = options.rpcUrl ?? DEFAULT_RPC[network];
  if (!rpcUrl) {
    return report({
      status: "unknown",
      network,
      tx,
      rpcUrl: "",
      detail: `No default RPC for ${describeNetwork(network)}. Pass --rpc <url>.`,
      exitCode: 2,
    });
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const namespace = network.slice(0, network.indexOf(":"));

  try {
    if (namespace === "eip155") {
      return await reconcileEvm({ tx, network, rpcUrl, fetchImpl, timeoutMs });
    }
    if (namespace === "solana") {
      return await reconcileSolana({ tx, network, rpcUrl, fetchImpl, timeoutMs });
    }
    return report({
      status: "unknown",
      network,
      tx,
      rpcUrl,
      detail: `Namespace "${namespace}" is not supported by reconcile. Use eip155:* or solana:*.`,
      exitCode: 2,
    });
  } catch (error) {
    return report({
      status: "unknown",
      network,
      tx,
      rpcUrl,
      detail: `RPC call failed: ${(error as Error).message}. Nothing is known about this transaction, so do not treat this as either safe or unsafe to retry.`,
      exitCode: EXIT_UNKNOWN,
    });
  }
}

async function reconcileEvm(input: {
  tx: string;
  network: string;
  rpcUrl: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}): Promise<ReconcileResult> {
  const receipt = (await rpc(input, "eth_getTransactionReceipt", [input.tx])) as
    | { status?: string; blockNumber?: string }
    | null;

  if (receipt === null) {
    const pending = (await rpc(input, "eth_getTransactionByHash", [input.tx])) as
      | { hash?: string }
      | null;
    if (pending && pending.hash) {
      return report({
        status: "pending",
        network: input.network,
        tx: input.tx,
        rpcUrl: input.rpcUrl,
        detail: "Transaction is in the mempool or not yet mined. Do not retry the payment.",
        // Distinct from `not_found`: this one is on chain and will confirm, so a
        // retry would pay twice. `not_found` means the opposite — nothing
        // broadcast, so a fresh payment is safe. Both used to exit 1, which made
        // the CLI's only stated purpose ("know whether it is safe to retry")
        // unavailable to a script without parsing --json.
        exitCode: EXIT_PENDING,
      });
    }
    return report({
      status: "not_found",
      network: input.network,
      tx: input.tx,
      rpcUrl: input.rpcUrl,
      detail:
        "No transaction with this hash on this network. The settle may never have broadcast — a fresh payment is safe.",
      exitCode: EXIT_NOT_FOUND,
    });
  }

  const statusHex = receipt.status ?? "0x0";
  const confirmed = statusHex === "0x1" || statusHex === "1";
  const block = receipt.blockNumber
    ? String(Number.parseInt(receipt.blockNumber, 16))
    : undefined;

  if (confirmed) {
    return report({
      status: "confirmed",
      network: input.network,
      tx: input.tx,
      rpcUrl: input.rpcUrl,
      ...(block ? { block } : {}),
      detail: `Receipt status success${block ? ` in block ${block}` : ""}. Settlement landed; do not charge the buyer again.`,
      exitCode: 0,
    });
  }

  return report({
    status: "failed",
    network: input.network,
    tx: input.tx,
    rpcUrl: input.rpcUrl,
    ...(block ? { block } : {}),
    detail: `Receipt status failed${block ? ` in block ${block}` : ""}. Funds did not move; a fresh payment is safe after investigation.`,
    exitCode: 1,
  });
}

async function reconcileSolana(input: {
  tx: string;
  network: string;
  rpcUrl: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}): Promise<ReconcileResult> {
  const value = (await rpc(input, "getTransaction", [
    input.tx,
    { encoding: "json", maxSupportedTransactionVersion: 0 },
  ])) as { meta?: { err?: unknown }; slot?: number } | null;

  if (value === null) {
    return report({
      status: "not_found",
      network: input.network,
      tx: input.tx,
      rpcUrl: input.rpcUrl,
      detail: "Signature not found on this cluster. It may still be propagating, or it never landed.",
      exitCode: 1,
    });
  }

  const err = value.meta?.err;
  const slot = value.slot !== undefined ? String(value.slot) : undefined;
  if (err == null) {
    return report({
      status: "confirmed",
      network: input.network,
      tx: input.tx,
      rpcUrl: input.rpcUrl,
      ...(slot ? { block: slot } : {}),
      detail: `Transaction confirmed${slot ? ` at slot ${slot}` : ""}. Settlement landed; do not charge the buyer again.`,
      exitCode: 0,
    });
  }

  return report({
    status: "failed",
    network: input.network,
    tx: input.tx,
    rpcUrl: input.rpcUrl,
    ...(slot ? { block: slot } : {}),
    detail: `Transaction failed on chain${slot ? ` at slot ${slot}` : ""}: ${JSON.stringify(err)}.`,
    exitCode: 1,
  });
}

async function rpc(
  input: { rpcUrl: string; fetchImpl: typeof fetch; timeoutMs: number },
  method: string,
  params: unknown[],
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await input.fetchImpl(input.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) {
      throw new Error(body.error.message ?? "RPC error");
    }
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

function report(
  result: Omit<ReconcileResult, "text"> & { text?: string },
): ReconcileResult {
  const lines = [
    `tx:      ${result.tx || "(none)"}`,
    `network: ${result.network ? describeNetwork(result.network) : "(none)"}`,
    `rpc:     ${result.rpcUrl || "(none)"}`,
    `status:  ${result.status}`,
    ...(result.block ? [`block:   ${result.block}`] : []),
    "",
    result.detail,
  ];
  return { ...result, text: lines.join("\n") };
}

