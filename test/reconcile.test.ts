/**
 * `x402-lens reconcile` — on-chain settlement lookup against a stub RPC.
 */

import { describe, expect, it } from "vitest";
import { reconcileTransaction } from "../packages/cli/src/commands/reconcile";
import { main } from "../packages/cli/src/index";

function mockFetch(handler: (body: { method: string; params: unknown[] }) => unknown): typeof fetch {
  return (async (_url: string | URL, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body ?? "{}")) as {
      method: string;
      params: unknown[];
    };
    return {
      ok: true,
      async json() {
        return { result: handler(payload) };
      },
    } as Response;
  }) as typeof fetch;
}

describe("reconcileTransaction", () => {
  it("reports confirmed when the EVM receipt status is success", async () => {
    const result = await reconcileTransaction({
      tx: `0x${"ab".repeat(32)}`,
      network: "eip155:84532",
      fetchImpl: mockFetch(({ method }) => {
        if (method === "eth_getTransactionReceipt") {
          return { status: "0x1", blockNumber: "0x10" };
        }
        return null;
      }),
    });

    expect(result.status).toBe("confirmed");
    expect(result.exitCode).toBe(0);
    expect(result.block).toBe("16");
    expect(result.text).toMatch(/do not charge the buyer again/i);
  });

  it("reports pending when the hash is known but has no receipt", async () => {
    const result = await reconcileTransaction({
      tx: `0x${"cd".repeat(32)}`,
      network: "eip155:84532",
      fetchImpl: mockFetch(({ method }) => {
        if (method === "eth_getTransactionReceipt") return null;
        if (method === "eth_getTransactionByHash") return { hash: `0x${"cd".repeat(32)}` };
        return null;
      }),
    });

    expect(result.status).toBe("pending");
    expect(result.exitCode).toBe(1);
    expect(result.detail).toMatch(/Do not retry/i);
  });

  it("reports not_found when neither receipt nor tx exists", async () => {
    const result = await reconcileTransaction({
      tx: `0x${"ef".repeat(32)}`,
      network: "eip155:84532",
      fetchImpl: mockFetch(() => null),
    });

    expect(result.status).toBe("not_found");
    expect(result.exitCode).toBe(1);
  });

  it("reports failed on a reverted EVM receipt", async () => {
    const result = await reconcileTransaction({
      tx: `0x${"11".repeat(32)}`,
      network: "eip155:84532",
      fetchImpl: mockFetch(() => ({ status: "0x0", blockNumber: "0x2" })),
    });

    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(1);
  });

  it("reports confirmed for a successful Solana signature", async () => {
    const result = await reconcileTransaction({
      tx: "5VEJv1M",
      network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      fetchImpl: mockFetch(() => ({ meta: { err: null }, slot: 42 })),
    });

    expect(result.status).toBe("confirmed");
    expect(result.block).toBe("42");
    expect(result.exitCode).toBe(0);
  });

  it("rejects a non-CAIP-2 network with an exit code 2", async () => {
    const result = await reconcileTransaction({
      tx: "0x1",
      network: "base-sepolia",
    });
    expect(result.exitCode).toBe(2);
    expect(result.detail).toMatch(/eip155:84532/);
  });
});

describe("reconcile CLI wiring", () => {
  it("requires --tx", async () => {
    const code = await main(["reconcile"]);
    expect(code).toBe(2);
  });
});
