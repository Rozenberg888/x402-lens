/**
 * Acceptance example: x402 protection on an existing Express route.
 *
 * The protection is three lines (lens + subscribe + mount). Everything else is
 * the app that was already there.
 *
 * Run it:
 *   X402_FACILITATOR_URL=https://x402.org/facilitator \
 *   X402_NETWORK=eip155:84532 \
 *   X402_PAY_TO=0xYourAddress \
 *   npm start
 *
 * Then, unpaid:            curl -i localhost:4021/weather
 * Inspect from outside:    npx x402-lens inspect http://localhost:4021/weather
 */

import express from "express";
import { paymentLens } from "@x402-lens/express";

const app = express();

const lens = paymentLens({
  routes: { "GET /weather": "$0.001" },
  // A browser buyer cannot read PAYMENT-REQUIRED or send PAYMENT-SIGNATURE
  // without these. Skip this if your app already sets CORS headers.
  cors: { origin: "*" },
});
lens.on(event => console.log(event.type, event.route, event.network));

await lens.ready;
app.use(lens.middleware);

app.get("/weather", (_req, res) => {
  res.json({ weather: "sunny", temperature: 70 });
});

const port = Number(process.env.PORT ?? 4021);
app.listen(port, () => {
  console.log(`Listening on http://localhost:${port} — try GET /weather`);
});
