/**
 * A facilitator good enough to exercise the real middleware.
 *
 * It implements the three endpoints the SDK uses — `/supported`, `/verify`,
 * `/settle` — and nothing else. Tests drive it by setting `verifyResult` and
 * `settleResult`, so a scenario change is one assignment rather than a new
 * server.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockFacilitator {
  url: string;
  /** What `/verify` should answer next. */
  verifyResult: {
    isValid: boolean;
    invalidReason?: string;
    invalidMessage?: string;
    payer?: string;
  };
  /** What `/settle` should answer next. */
  settleResult: {
    success: boolean;
    errorReason?: string;
    transaction?: string;
    network?: string;
    payer?: string;
  };
  /** Every request body the facilitator received, for assertions. */
  calls: Array<{ path: string; body: unknown }>;
  close(): Promise<void>;
}

export interface MockFacilitatorOptions {
  network?: string;
  /**
   * Networks to advertise in `/supported`. Defaults to `[network]`.
   *
   * Multi-network routes are validated against this list at startup, so a mock
   * that advertises only one network makes a two-network config fail.
   */
  networks?: string[];
  /**
   * Schemes to advertise. Defaults to `["exact"]`.
   *
   * The SDK validates every route's scheme against this at startup and treats a
   * missing one as fatal, so a test using `upto` must advertise it.
   */
  schemes?: string[];
  /** Return 500 from `/supported` to exercise the facilitator-error path. */
  failSupported?: boolean;
}

/**
 * Start a facilitator on an ephemeral port.
 *
 * @param options - Network to advertise and fault injection switches
 * @returns Handle with the URL, mutable results, and a close function
 */
export async function startMockFacilitator(
  options: MockFacilitatorOptions = {},
): Promise<MockFacilitator> {
  const network = options.network ?? "eip155:84532";
  const calls: MockFacilitator["calls"] = [];

  const handle: MockFacilitator = {
    url: "",
    verifyResult: { isValid: true, payer: "0x857b06519E91e3A54538791bDAbd0E22373e36b66" },
    settleResult: {
      success: true,
      transaction: `0x${"11".repeat(32)}`,
      network,
      payer: "0x857b06519E91e3A54538791bDAbd0E22373e36b66",
    },
    calls,
    close: async () => {},
  };

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? (JSON.parse(raw) as unknown) : undefined;
      const path = (request.url ?? "/").replace(/^\/+/, "").split("?")[0] ?? "";
      calls.push({ path, body });

      const send = (status: number, payload: unknown): void => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      };

      switch (path) {
        case "supported":
          if (options.failSupported) {
            send(500, { error: "facilitator_unavailable" });
            return;
          }
          send(200, {
            kinds: (options.networks ?? [network]).flatMap(kindNetwork =>
              (options.schemes ?? ["exact"]).map(scheme => ({
                x402Version: 2,
                scheme,
                network: kindNetwork,
              })),
            ),
            extensions: [],
            signers: {},
          });
          return;
        case "verify":
          send(200, handle.verifyResult);
          return;
        case "settle":
          send(200, handle.settleResult);
          return;
        default:
          send(404, { error: "not_found" });
      }
    });
  });

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  handle.url = `http://127.0.0.1:${address.port}`;
  handle.close = () =>
    new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
    });

  return handle;
}
