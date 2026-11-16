/**
 * Record real x402 wire objects into `test/fixtures/`.
 *
 * Hand-written fixtures encode what we *think* the protocol looks like. A
 * recorded one encodes what a real middleware actually emitted, so a
 * specification change shows up as a diff in review instead of as a bug report
 * from a user whose payment started failing.
 *
 *   npm run fixtures:record
 *
 * Records against the local example server and the public facilitator, so it
 * needs network access. The output is committed; re-record only when the
 * protocol genuinely changes, and read the diff before committing it.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import express from "express";
import { decodePaymentRequiredHeader, encodePaymentRequiredHeader } from "@x402/core/http";
import { paymentLens } from "@x402-lens/express";

const OUT_DIR = resolve(import.meta.dirname, "..", "test", "fixtures", "recorded");

/** Public facilitator networks used for the recorded challenge. */
const EVM = "eip155:84532";
const SVM = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

const PAY_TO = {
  [EVM]: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
  [SVM]: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
};

/**
 * Replace the ephemeral port and random host with a stable placeholder.
 *
 * A recorded fixture is committed, so it must not change on every run: a random
 * port would produce a diff each time and make review meaningless. The URL is
 * the only field that varies, and the diagnostics never read it.
 *
 * @param value - Decoded challenge
 * @returns The same challenge with a stable resource URL
 */
function stabilise(value) {
  return {
    ...value,
    resource: value.resource
      ? { ...value.resource, url: "https://api.example.com/weather" }
      : value.resource,
  };
}

/**
 * Write one fixture, pretty-printed.
 *
 * @param name - File name without extension
 * @param value - JSON-serialisable payload
 */
async function write(name, value) {
  const path = join(OUT_DIR, `${name}.json`);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  process.stdout.write(`wrote ${name}.json\n`);
}

/**
 * Start the example-shaped server on an ephemeral port and return its base URL.
 *
 * @returns {Promise<{ url: string; close: () => Promise<void> }>}
 */
async function startServer() {  const lens = paymentLens({
    facilitatorUrl: "https://x402.org/facilitator",
    networks: [EVM, SVM],
    payTo: PAY_TO,
    routes: {
      "GET /weather": "$0.001",
      "POST /generate": { price: "0.05", paymentFlow: "upfront" },
    },
    cors: true,
    sinks: { console: false },
  });

  const app = express();
  app.use(lens.middleware);
  app.get("/weather", (_req, res) => res.json({ weather: "sunny" }));
  app.post("/generate", (_req, res) => res.json({ text: "ok" }));

  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolveReady => server.once("listening", resolveReady));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise(done => {
        server.close(() => done());
      }),
  };
}

const server = await startServer();

try {
  await mkdir(OUT_DIR, { recursive: true });

  // A three-entry EVM challenge is not possible from one route, but the shape
  // with two networks is what a real deployment produces.
  const weather = await fetch(`${server.url}/weather`);
  const weatherHeader = weather.headers.get("payment-required");
  if (!weatherHeader) throw new Error("no PAYMENT-REQUIRED header on /weather");
  const weatherChallenge = decodePaymentRequiredHeader(weatherHeader);

  await write("challenge-two-networks", {
    note: "GET /weather on a route priced $0.001 on Base Sepolia and Solana devnet, with cors enabled. Resource URL is stabilised: the recorder listens on an ephemeral port.",
    capturedAt: new Date().toISOString(),
    facilitator: "https://x402.org/facilitator",
    body: stabilise(weatherChallenge),
  });

  const generate = await fetch(`${server.url}/generate`, { method: "POST" });
  const generateHeader = generate.headers.get("payment-required");
  if (!generateHeader) throw new Error("no PAYMENT-REQUIRED header on /generate");
  const generateChallenge = decodePaymentRequiredHeader(generateHeader);

  await write("challenge-upfront-flow", {
    note: "POST /generate with paymentFlow: upfront — the only difference from the default challenge is extra.paymentFlow.",
    capturedAt: new Date().toISOString(),
    body: stabilise(generateChallenge),
  });

  // Re-encoding must round-trip, or a client and server disagree about bytes.
  const reEncoded = encodePaymentRequiredHeader(weatherChallenge);
  const roundTripped = decodePaymentRequiredHeader(reEncoded);
  if (JSON.stringify(roundTripped) !== JSON.stringify(weatherChallenge)) {
    throw new Error("PAYMENT-REQUIRED does not round-trip through base64");
  }
  process.stdout.write("ok   PAYMENT-REQUIRED round-trips through base64\n");

  // A well-formed EVM payload needs a real signature, which needs a key; the
  // structure is what the diagnostics read, so record the structure only and
  // say so in the fixture.
  await write("payload-evm-exact-shape", {
    note: "Structural shape of an EVM exact payload. The signature is a placeholder: the diagnostics read the authorization fields, not the signature bytes.",
    capturedAt: new Date().toISOString(),
    body: {
      x402Version: 2,
      resource: weatherChallenge.resource,
      accepted: weatherChallenge.accepts?.[0],
      payload: {
        signature: `0x${"ab".repeat(65)}`,
        authorization: {
          from: "0x857b06519E91e3A54538791bDAbd0E22373e36b66",
          to: PAY_TO[EVM],
          value: weatherChallenge.accepts?.[0]?.amount,
          validAfter: "0",
          validBefore: String(Math.floor(Date.now() / 1000) + 3600),
          nonce: `0x${"cd".repeat(32)}`,
        },
      },
    },
  });

  // The facilitator's own vocabulary is the reference the findings map onto.
  const supported = await fetch("https://x402.org/facilitator/supported");
  if (!supported.ok) throw new Error(`/supported returned ${supported.status}`);
  await write("facilitator-supported", {
    note: "GET /supported from the public facilitator. Findings map invalidReason/errorReason codes from this vocabulary.",
    capturedAt: new Date().toISOString(),
    facilitator: "https://x402.org/facilitator",
    body: await supported.json(),
  });
} finally {
  await server.close();
}
