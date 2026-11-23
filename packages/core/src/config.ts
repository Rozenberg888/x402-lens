/**
 * Configuration loading for x402-lens.
 *
 * Deliberately hostile to defaults: a missing facilitator URL, network, or
 * receiving address is a configuration error, never a silent fallback to a
 * public facilitator or mainnet. Getting that wrong in production means either
 * lost revenue or payments sent to the wrong chain.
 *
 * Two entry points share one set of rules:
 *
 * - `resolveConfig` is synchronous, taking explicit values plus an env map.
 * - `loadConfig` additionally reads `x402.config.json` from disk.
 *
 * Keeping validation in `resolveConfigSync` means the Express wrapper can build
 * middleware synchronously without a second copy of the rules.
 */

import { readFile } from "node:fs/promises";
import { isCaip2, suggestCaip2, describeNetwork } from "./networks.js";

/** Raised when configuration is missing or malformed. */
export class ConfigError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = "ConfigError";
    this.field = field;
  }
}

/**
 * A price in a specific token rather than a `$`-pegged decimal.
 *
 * Use this when the route is priced in something the default USD pegging cannot
 * express — a non-stablecoin, or a token the SDK has no default decimals for.
 * `amount` is atomic units, because that is what goes on the wire.
 */
export interface AssetPrice {
  /** Token contract address (EVM) or mint (SVM). */
  asset: string;
  /** Amount in atomic units, as an integer string. */
  amount: string;
}

/** A single protected route and what it costs. */
export interface RoutePrice {
  /** HTTP method, e.g. `GET`. `*` matches any. */
  method: string;
  /** Express-style path, e.g. `/weather` or `/users/:id`. */
  path: string;
  /** Price as a decimal string in the configured asset, e.g. `"0.001"`. */
  price: string | AssetPrice;
  /** Optional description surfaced in the 402 body and paywall. */
  description?: string;
  /** MIME type of the protected resource, e.g. `application/json`. */
  mimeType?: string;
  /** Human name for this resource, shown in discovery listings. */
  serviceName?: string;
  /** Icon URL for the resource, shown in paywalls and listings. */
  iconUrl?: string;
  /** Free-form tags for discovery, e.g. `["weather", "forecast"]`. */
  tags?: string[];
  /** Per-route override of the advertised settlement window, seconds. */
  maxTimeoutSeconds?: number;
  /**
   * When the money moves relative to your handler.
   *
   * - `authorization` (default) verifies, runs the handler, then settles. A
   *   settlement failure after a `200` means the buyer got the data and you got
   *   nothing. Acceptable for cheap, repeatable reads.
   * - `upfront` settles first, then runs the handler. No goods without payment;
   *   the trade-off is that a handler crash after settlement needs a refund.
   *
   * Choose by which failure costs more. For anything expensive or
   * non-repeatable — generation, inference, writes — `upfront` is the safe side.
   */
  paymentFlow?: PaymentFlow;
  /**
   * Payment scheme. Defaults to `exact`.
   *
   * - `exact` — the buyer signs for the exact advertised amount.
   * - `upto` — the buyer signs a ceiling and the server charges what was used.
   *   The natural fit for metered work: tokens, compute, anything whose real
   *   cost is only known after the handler runs.
   *
   * Not every combination is valid. `upto` on EVM settles only after the handler
   * (`authorization`), and on Solana only through an escrow channel (`escrow`),
   * so a mismatched `paymentFlow` is refused at config time — the SDK otherwise
   * treats it as a fatal startup error and exits the process.
   */
  scheme?: PaymentScheme;
  /**
   * Flow override for `upto`, where the valid value differs per network family.
   *
   * Only needed for Solana `upto`, which requires `escrow`. Omitting it picks the
   * scheme's default, which is correct in almost every case.
   */
  uptoFlow?: "authorization" | "escrow";
}

/** Supported payment schemes. */
export type PaymentScheme = "exact" | "upto";

/** When settlement happens relative to the route handler. */
export type PaymentFlow = "authorization" | "upfront";

export interface LensConfig {
  /** Facilitator origin, e.g. `https://x402.org/facilitator`. */
  facilitatorUrl: string;
  /** Primary CAIP-2 network id, e.g. `eip155:84532`. Always `networks[0]`. */
  network: string;
  /**
   * Every network a route may be paid on, in challenge order.
   *
   * A route priced in USDC on both Base and Solana advertises two `accepts[]`
   * entries; a client pays whichever chain it holds funds on. Defaults to
   * `[network]`, so a single-network setup needs no change.
   */
  networks: string[];
  /** Receiving wallet address on the primary network. */
  payTo: string;
  /**
   * Receiving address per configured network.
   *
   * An address is chain-specific: a 20-byte EVM address is not a Solana public
   * key. Keyed by network id so each `accepts[]` entry carries a usable
   * recipient rather than the first network's by accident.
   */
  payToByNetwork: Record<string, string>;
  /** Protected routes. */
  routes: RoutePrice[];
  /** Settlement timeout advertised to buyers, seconds. */
  maxTimeoutSeconds: number;
  /**
   * Static headers sent to the facilitator, keyed by endpoint.
   *
   * For facilitators behind an API key. Each path gets its own object because
   * that is the shape `@x402/core` requires — a flat headers object is rejected
   * at config time (`ConfigError`), before the first payment request.
   */
  facilitatorHeaders?: FacilitatorHeaders;
  /** Per-request timeout for facilitator calls, milliseconds. SDK default: 90000. */
  facilitatorTimeoutMs?: number;
}

/**
 * Where a route pays out.
 *
 * A plain string applies to every configured network, which is only correct
 * when they share an address format — two EVM chains, for example. A record
 * gives each network (or each namespace) its own address.
 */
export type PayToInput = string | Record<string, string>;

/** Auth headers for the facilitator, one object per endpoint. */
export interface FacilitatorHeaders {
  verify?: Record<string, string>;
  settle?: Record<string, string>;
  supported?: Record<string, string>;
  bazaar?: Record<string, string>;
}

/** A route in either the short `route: "GET /weather"` form or the full form. */
export type RouteInput = RoutePrice | (Omit<RoutePrice, "method" | "path"> & { route: string });

/**
 * Routes as a map of `"METHOD /path"` to a price or per-route options.
 *
 * This is the shape everyone writes first — `{ "GET /weather": "$0.001" }` —
 * and it is what `x402-lens add` rewrites in source. Accepting it in
 * `x402.config.json` too means a config file and a code call cannot disagree
 * about which forms exist.
 */
export type RouteMap = Record<string, string | Omit<RoutePrice, "method" | "path">>;

/** Routes in either the array form or the map form. */
export type RoutesInput = RouteInput[] | RouteMap;

/** Partially-specified config, as accepted from code or a config file. */
export interface LensConfigInput {
  facilitatorUrl?: string;
  network?: string;
  /** Networks a route may be paid on. Overrides `network` when present. */
  networks?: string[];
  /** Receiving address, shared across networks or keyed by network. */
  payTo?: PayToInput;
  /** Protected routes, as an array or a `"METHOD /path"` map. */
  routes?: RoutesInput;
  maxTimeoutSeconds?: number;
  facilitatorHeaders?: FacilitatorHeaders;
  facilitatorTimeoutMs?: number;
}

/** Everything `resolveConfig` may consult. */
export interface ResolveConfigInput extends LensConfigInput {
  /** Environment source. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

export interface LoadConfigOptions extends ResolveConfigInput {
  /** Directory used to resolve `x402.config.json`. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Set false to skip reading `x402.config.json` from disk. */
  readConfigFile?: boolean;
}

const DEFAULT_MAX_TIMEOUT_SECONDS = 60;

/**
 * Resolve and validate configuration from explicit values and environment
 * variables. Pure and synchronous — no filesystem access.
 *
 * Precedence for each field: explicit option → environment variable.
 *
 * @param input - Explicit values plus the env map to fall back to
 * @returns Fully validated configuration
 * @throws {ConfigError} When a required field is absent or malformed
 */
export function resolveConfig(input: ResolveConfigInput = {}): LensConfig {
  const env = input.env ?? process.env;

  const facilitatorUrl = pickString(input.facilitatorUrl, env.X402_FACILITATOR_URL);
  const networks = resolveNetworks(input, env);
  // Pass the resolved list, not the environment: with networks supplied in code,
  // `X402_PAY_TO_<network>` has to resolve against those or it is dropped.
  const payTo = resolvePayTo(input, env, networks);

  if (!facilitatorUrl) {
    throw new ConfigError(
      "facilitatorUrl",
      "facilitatorUrl is required. Set X402_FACILITATOR_URL (e.g. https://x402.org/facilitator for Base Sepolia and Solana devnet) — x402-lens never defaults it.",
    );
  }
  assertUrl("facilitatorUrl", facilitatorUrl);

  if (networks.length === 0) {
    throw new ConfigError(
      "network",
      "network is required. Set X402_NETWORK to a CAIP-2 id such as eip155:84532 (Base Sepolia) or solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1 (Solana devnet).",
    );
  }
  for (const network of networks) assertCaip2(network);

  const payToByNetwork = resolvePayToByNetwork(payTo, networks);

  const routes = normaliseRoutes(input.routes ?? routesFromEnv(env));
  if (routes.length === 0) {
    throw new ConfigError(
      "routes",
      'No routes configured. Pass routes: { "GET /weather": "$0.001" } or set X402_PRICE__GET_/weather=0.001.',
    );
  }

  const maxTimeoutSeconds =
    input.maxTimeoutSeconds ??
    parseTimeout(env.X402_MAX_TIMEOUT_SECONDS) ??
    DEFAULT_MAX_TIMEOUT_SECONDS;

  const facilitatorTimeoutMs = resolveFacilitatorTimeout(input, env);
  const facilitatorHeaders = resolveFacilitatorHeaders(input, env);

  assertAssetPricesSurviveMultipleNetworks(routes, networks);
  assertSchemesAreValid(routes, networks);

  return {
    facilitatorUrl: facilitatorUrl.replace(/\/+$/, ""),
    network: networks[0] as string,
    networks,
    payTo: payToByNetwork[networks[0] as string] as string,
    payToByNetwork,
    routes,
    maxTimeoutSeconds,
    ...(facilitatorHeaders ? { facilitatorHeaders } : {}),
    ...(facilitatorTimeoutMs !== undefined ? { facilitatorTimeoutMs } : {}),
  };
}

/**
 * Read the receiving address, from an explicit value or `X402_PAY_TO`.
 *
 * `X402_PAY_TO_<NETWORK>` overrides the shared address for one network, since
 * environment variables cannot express a nested object.
 */
function resolvePayTo(
  input: ResolveConfigInput,
  env: Record<string, string | undefined>,
  networks: string[],
): PayToInput | undefined {
  if (typeof input.payTo === "string" || input.payTo) return input.payTo;

  const shared = pickString(env.X402_PAY_TO);
  const perNetwork: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("X402_PAY_TO_") || !value) continue;
    const network = networkFromEnvSuffix(key.slice("X402_PAY_TO_".length), networks);
    if (network) perNetwork[network] = value.trim();
  }

  if (Object.keys(perNetwork).length === 0) return shared;
  return { ...(shared ? { "*": shared } : {}), ...perNetwork };
}

/**
 * Map a `X402_PAY_TO_<SUFFIX>` suffix back onto a configured network.
 *
 * The suffix cannot contain `:` on most shells, so `eip155_84532` is accepted as
 * well as the literal id.
 *
 * `configured` is the network list the caller actually resolved, not the one in
 * the environment. Reading only env vars meant that with
 * `networks: ["eip155:8453", "eip155:84532"]` in code plus
 * `X402_PAY_TO_EIP155_8453`, the per-network address was silently dropped and
 * the shared `X402_PAY_TO` was used for every chain — payments landing in the
 * wrong wallet, with no error anywhere.
 *
 * @param suffix - The part after `X402_PAY_TO_`
 * @param configured - Networks this configuration resolved to
 * @returns The matching network id, if any
 */
function networkFromEnvSuffix(
  suffix: string,
  configured: string[],
): string | undefined {
  const normalised = suffix.replace(/_/g, ":");
  return configured.find(
    network => network === suffix || network === normalised || envKey(network) === suffix,
  );
}

/** Environment-safe form of a network id, e.g. `eip155:84532` → `eip155_84532`. */
function envKey(network: string): string {
  return network.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
}

/**
 * Resolve one receiving address per network and prove each fits.
 *
 * A 20-byte EVM address is not a Solana public key. Reusing one address for
 * every network would advertise a recipient nobody can pay on the other chain,
 * so a mismatch is a configuration error rather than a warning.
 */
function resolvePayToByNetwork(
  payTo: PayToInput | undefined,
  networks: string[],
): Record<string, string> {
  if (!payTo) {
    throw new ConfigError(
      "payTo",
      `payTo is required. Set X402_PAY_TO to the wallet address that receives payments on ${describeNetwork(
        networks[0] ?? "",
      )}.`,
    );
  }

  const resolved: Record<string, string> = {};

  if (typeof payTo === "string") {
    const shared = payTo.trim();
    if (shared.length === 0) {
      throw new ConfigError("payTo", "payTo is empty.");
    }
    assertAddressFits(shared, networks[0] ?? "", "payTo");
    // One address for several networks is only legitimate when the formats
    // agree; assert that here so the mistake surfaces at config time.
    for (const network of networks) assertAddressFits(shared, network, "payTo");
    for (const network of networks) resolved[network] = shared;
    return resolved;
  }

  const wildcard = payTo["*"];
  for (const network of networks) {
    const namespace = network.slice(0, network.indexOf(":"));
    const address = pickString(payTo[network], payTo[namespace], wildcard);
    if (!address) {
      throw new ConfigError(
        "payTo",
        `payTo has no address for ${describeNetwork(network)}. Add one for "${network}" (or for the "${namespace}" namespace, or "*") — each network needs a wallet that exists on it.`,
      );
    }
    assertAddressFits(address, network, "payTo");
    resolved[network] = address;
  }
  return resolved;
}

/** Reject an address whose format does not belong to the network. */
function assertAddressFits(address: string, network: string, field: string): void {
  const namespace = network.slice(0, network.indexOf(":"));

  if (namespace === "eip155") {
    if (/^0x[0-9a-fA-F]{40}$/.test(address)) return;
    throw new ConfigError(
      field,
      `${field} "${address}" is not a 0x-prefixed 20-byte address, which ${describeNetwork(network)} requires. A Solana key cannot receive on an EVM chain — use payTo: { "${network}": "0x…" } to give each network its own address.`,
    );
  }

  if (namespace === "solana") {
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return;
    throw new ConfigError(
      field,
      `${field} "${address}" is not a base58 Solana public key, which ${describeNetwork(network)} requires. An EVM address cannot receive on Solana — use payTo: { "${network}": "…" } to give each network its own address.`,
    );
  }
}

/**
 * Resolve configuration, additionally reading `x402.config.json` when present.
 *
 * Precedence for each field: explicit option → environment → config file.
 * `facilitatorHeaders` is never read from the file (secrets stay in env/code).
 *
 * @param options - Explicit values plus cwd/env used for fallbacks
 * @returns Fully validated configuration
 * @throws {ConfigError} When a required field is absent or malformed
 */
export async function loadConfig(
  options: LoadConfigOptions = {},
): Promise<LensConfig> {
  const fileConfig =
    options.readConfigFile === false ? {} : await readConfigFile(options.cwd ?? process.cwd());

  // Secrets must not live in a committed config file. Auth belongs in
  // X402_FACILITATOR_TOKEN / paymentLens({ facilitatorHeaders }) / env.
  if (fileConfig.facilitatorHeaders !== undefined) {
    throw new ConfigError(
      "facilitatorHeaders",
      'facilitatorHeaders must not be set in x402.config.json (secrets belong in the environment). Use X402_FACILITATOR_TOKEN or paymentLens({ facilitatorHeaders: { verify: {…}, settle: {…}, supported: {…} } }).',
    );
  }

  return resolveConfig({
    facilitatorUrl:
      pickString(options.facilitatorUrl) ?? pickString(fileConfig.facilitatorUrl),
    ...(options.network !== undefined
      ? { network: options.network }
      : fileConfig.network !== undefined
        ? { network: fileConfig.network }
        : {}),
    ...(options.networks !== undefined
      ? { networks: options.networks }
      : fileConfig.networks !== undefined
        ? { networks: fileConfig.networks }
        : {}),
    ...(options.payTo !== undefined
      ? { payTo: options.payTo }
      : fileConfig.payTo !== undefined
        ? { payTo: fileConfig.payTo }
        : {}),
    routes: options.routes ?? fileConfig.routes,
    ...(options.maxTimeoutSeconds !== undefined
      ? { maxTimeoutSeconds: options.maxTimeoutSeconds }
      : fileConfig.maxTimeoutSeconds !== undefined
        ? { maxTimeoutSeconds: fileConfig.maxTimeoutSeconds }
        : {}),
    ...(options.facilitatorHeaders !== undefined
      ? { facilitatorHeaders: options.facilitatorHeaders }
      : {}),
    ...(options.facilitatorTimeoutMs !== undefined
      ? { facilitatorTimeoutMs: options.facilitatorTimeoutMs }
      : fileConfig.facilitatorTimeoutMs !== undefined
        ? { facilitatorTimeoutMs: fileConfig.facilitatorTimeoutMs }
        : {}),
    env: options.env,
  });
}

function pickString(...candidates: Array<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}

/**
 * Read the network list.
 *
 * `networks` (or `X402_NETWORKS=a,b`) wins over `network`, which stays supported
 * because every existing deployment sets it. Order is preserved because it is
 * the order `accepts[]` is advertised in.
 */
function resolveNetworks(
  input: ResolveConfigInput,
  env: Record<string, string | undefined>,
): string[] {
  const explicit = input.networks ?? parseNetworkList(env.X402_NETWORKS);
  const single = pickString(input.network, env.X402_NETWORK);

  const source = explicit && explicit.length > 0 ? explicit : single ? [single] : [];
  const seen = new Set<string>();
  const networks: string[] = [];
  for (const raw of source) {
    const network = raw.trim();
    if (network.length === 0 || seen.has(network)) continue;
    seen.add(network);
    networks.push(network);
  }
  return networks;
}

function parseNetworkList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(",")
    .map(part => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

function assertUrl(field: string, value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError(field, `${field} "${value}" is not a valid URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError(
      field,
      `${field} must be an http(s) URL, got "${parsed.protocol}".`,
    );
  }
}

function assertCaip2(network: string): void {
  if (isCaip2(network)) return;
  const suggestion = suggestCaip2(network);
  throw new ConfigError(
    "network",
    `network "${network}" is not a CAIP-2 identifier.${
      suggestion
        ? ` Use "${suggestion}" instead.`
        : " Expected namespace:reference, e.g. eip155:84532."
    }`,
  );
}

/**
 * A token address is chain-specific, so one asset price cannot describe several
 * chains. Refusing beats guessing: picking one network silently would under- or
 * over-charge every buyer on the others.
 */
function assertAssetPricesSurviveMultipleNetworks(
  routes: RoutePrice[],
  networks: string[],
): void {
  if (networks.length < 2) return;
  const offending = routes.find(route => typeof route.price !== "string");
  if (!offending) return;
  throw new ConfigError(
    "routes",
    `Route "${offending.method} ${offending.path}" is priced in asset ${
      (offending.price as AssetPrice).asset
    }, but ${networks.length} networks are configured. A token address is chain-specific, so that price cannot describe all of them. Use one network for this route, or price it as a "$" amount so each network resolves its own default asset.`,
  );
}

/**
 * Refuse scheme/flow combinations the schemes cannot execute.
 *
 * This has to run during config resolution, not while building route configs:
 * `@x402/core` validates routes during its background init and answers a
 * `RouteConfigurationError` with `process.exit(1)`, so a server with one bad
 * route never starts and never explains itself over HTTP. Failing here means the
 * operator sees a route name and a reason at startup instead.
 *
 * The rules come from the schemes themselves: EVM `upto` supports only
 * `authorization`, Solana `upto` only `escrow` (a payment channel), and `exact`
 * supports both `authorization` and `upfront`.
 *
 * @param routes - Normalised routes
 * @param networks - Configured networks
 * @throws {ConfigError} On an impossible scheme/flow pair
 */
function assertSchemesAreValid(routes: RoutePrice[], networks: string[]): void {
  for (const route of routes) {
    const label = `${route.method} ${route.path}`;
    const scheme = route.scheme ?? "exact";

    if (scheme === "exact") {
      if (route.uptoFlow !== undefined) {
        throw new ConfigError(
          "routes",
          `Route "${label}" sets uptoFlow but uses scheme "exact". uptoFlow only applies to "upto"; use paymentFlow for exact.`,
        );
      }
      continue;
    }

    // scheme === "upto" — the flow is fixed per network family.
    if (route.paymentFlow !== undefined) {
      throw new ConfigError(
        "routes",
        `Route "${label}" uses scheme "upto" and also sets paymentFlow "${route.paymentFlow}". The flow is fixed by the scheme for upto — remove paymentFlow, or use scheme "exact" if you need to choose.`,
      );
    }

    for (const network of networks) {
      const isSolana = network.startsWith("solana:");
      const flow = route.uptoFlow ?? (isSolana ? "escrow" : "authorization");
      const allowed = isSolana ? ["escrow"] : ["authorization"];
      if (allowed.includes(flow)) continue;
      throw new ConfigError(
        "routes",
        `Route "${label}" uses scheme "upto" on ${describeNetwork(network)}, where the only valid flow is ${allowed
          .map(value => `"${value}"`)
          .join(" or ")} (got "${flow}"). On EVM upto settles after the handler; on Solana it runs through an escrow channel.`,
      );
    }
  }
}

function parseTimeout(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConfigError(
      "maxTimeoutSeconds",
      `X402_MAX_TIMEOUT_SECONDS must be a positive integer, got "${raw}".`,
    );
  }
  return parsed;
}

function resolveFacilitatorTimeout(
  input: ResolveConfigInput,
  env: Record<string, string | undefined>,
): number | undefined {
  const raw = input.facilitatorTimeoutMs ?? parsePositiveInt(env.X402_FACILITATOR_TIMEOUT_MS);
  if (raw === undefined) return undefined;
  if (!Number.isInteger(raw) || raw <= 0) {
    throw new ConfigError(
      "facilitatorTimeoutMs",
      `facilitatorTimeoutMs must be a positive integer, got ${String(input.facilitatorTimeoutMs ?? env.X402_FACILITATOR_TIMEOUT_MS)}.`,
    );
  }
  return raw;
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : NaN;
}

const FACILITATOR_HEADER_PATHS = ["verify", "settle", "supported", "bazaar"] as const;

/**
 * Build facilitator auth headers.
 *
 * A single token applies to every endpoint, which is what an API-key
 * facilitator expects. `facilitatorHeaders` wins when a facilitator needs
 * different credentials per endpoint.
 *
 * Flat header objects (e.g. `{ Authorization: "Bearer …" }`) are rejected here
 * so misconfig fails at startup — the SDK would otherwise throw on the first
 * facilitator call and surface as HTTP 500.
 */
function resolveFacilitatorHeaders(
  input: ResolveConfigInput,
  env: Record<string, string | undefined>,
): FacilitatorHeaders | undefined {
  if (input.facilitatorHeaders) {
    assertFacilitatorHeadersShape(input.facilitatorHeaders);
    return input.facilitatorHeaders;
  }

  const token = pickString(env.X402_FACILITATOR_TOKEN);
  if (!token) return undefined;

  const headers = { Authorization: `Bearer ${token}` };
  return {
    verify: { ...headers },
    settle: { ...headers },
    supported: { ...headers },
  };
}

/**
 * Mirror the SDK's createAuthHeaders path-key check so a flat object never
 * reaches the first payment request.
 */
function assertFacilitatorHeadersShape(headers: FacilitatorHeaders): void {
  const record = headers as Record<string, unknown>;
  const isHeaderObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

  if (Object.keys(record).length === 0) {
    throw new ConfigError(
      "facilitatorHeaders",
      "facilitatorHeaders is empty. Omit the field, or provide non-empty verify/settle/supported header maps.",
    );
  }

  const hasPathKey = FACILITATOR_HEADER_PATHS.some(key => isHeaderObject(record[key]));
  const looksFlat =
    !hasPathKey && Object.values(record).some(value => !isHeaderObject(value));

  if (looksFlat || !hasPathKey) {
    throw new ConfigError(
      "facilitatorHeaders",
      'facilitatorHeaders must be keyed by facilitator path, e.g. { verify: { Authorization: "…" }, settle: { … }, supported: { … } }. A flat headers object is rejected at config time.',
    );
  }

  for (const key of ["verify", "settle", "supported"] as const) {
    const value = record[key];
    if (!isHeaderObject(value) || Object.keys(value).length === 0) {
      throw new ConfigError(
        "facilitatorHeaders",
        `facilitatorHeaders.${key} must be a non-empty header map when facilitatorHeaders is set.`,
      );
    }
    for (const [headerName, headerValue] of Object.entries(value)) {
      if (typeof headerValue !== "string" || headerValue.trim().length === 0) {
        throw new ConfigError(
          "facilitatorHeaders",
          `facilitatorHeaders.${key}.${headerName} must be a non-empty string.`,
        );
      }
    }
  }
}

/**
 * Re-check a pre-built {@link LensConfig} (e.g. `paymentLens({ config })`) so
 * the money path never skips the same checks `resolveConfig` enforces.
 */
export function assertLensConfig(config: LensConfig): void {
  if (!config.facilitatorUrl?.trim()) {
    throw new ConfigError("facilitatorUrl", "facilitatorUrl is required.");
  }
  assertUrl("facilitatorUrl", config.facilitatorUrl);

  if (!config.networks || config.networks.length === 0) {
    throw new ConfigError(
      "network",
      "network is required. Set X402_NETWORK to a CAIP-2 id such as eip155:84532.",
    );
  }
  for (const network of config.networks) assertCaip2(network);

  if (!config.routes || config.routes.length === 0) {
    throw new ConfigError(
      "routes",
      'No routes configured. Pass routes: { "GET /weather": "$0.001" } or set X402_PRICE__GET_/weather=0.001.',
    );
  }
  for (const [index, route] of config.routes.entries()) {
    if (!route.path) {
      throw new ConfigError(
        `routes[${index}]`,
        `routes[${index}].path is required and must start with "/".`,
      );
    }
    assertPath(route.path, `${route.method} ${route.path}`, index);
    // Re-validate price/scheme/flow so a hand-built LensConfig cannot skip the
    // checks resolveConfig ran through normalisePrice / metadata.
    const normalised = normalisePrice(route.price, `routes[${index}]`);
    // Apply trimmed string prices in place so whitespace cannot reach the wire.
    if (typeof route.price === "string") {
      (route as { price: string }).price = normalised.price as string;
    }
    if (route.scheme !== undefined && route.scheme !== "exact" && route.scheme !== "upto") {
      throw new ConfigError(
        "routes",
        `Route "${route.method} ${route.path}".scheme is ${JSON.stringify(route.scheme)}. Use "exact" or "upto".`,
      );
    }
    // Reuse metadata() validation for paymentFlow / uptoFlow enums.
    metadata({
      method: route.method,
      path: route.path,
      paymentFlow: route.paymentFlow,
      uptoFlow: route.uptoFlow,
      scheme: route.scheme,
    });
  }

  for (const network of config.networks) {
    const address = config.payToByNetwork?.[network] ?? config.payTo;
    if (!address?.trim()) {
      throw new ConfigError(
        "payTo",
        `payTo has no address for ${describeNetwork(network)}.`,
      );
    }
    assertAddressFits(address, network, "payTo");
  }

  assertAssetPricesSurviveMultipleNetworks(config.routes, config.networks);
  assertSchemesAreValid(config.routes, config.networks);
  if (config.facilitatorHeaders) assertFacilitatorHeadersShape(config.facilitatorHeaders);
}

/**
 * Accept both route forms and reject everything else with a message that names
 * the shape the caller probably meant.
 */
function normaliseRoutes(raw: RoutesInput | undefined): RoutePrice[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return normaliseRouteArray(raw);

  if (typeof raw !== "object") {
    throw new ConfigError(
      "routes",
      'routes must be an array such as [{ route: "GET /weather", price: "$0.001" }] or a map such as { "GET /weather": "$0.001" }.',
    );
  }

  const entries: RouteInput[] = [];
  for (const [route, value] of Object.entries(raw)) {
    if (typeof value === "string") {
      entries.push({ route, price: value });
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      entries.push({ route, ...(value as Omit<RouteInput, "route">) });
      continue;
    }
    throw new ConfigError(
      "routes",
      `routes["${route}"] must be a price string or an options object, got ${JSON.stringify(value)}.`,
    );
  }
  return normaliseRouteArray(entries);
}

function normaliseRouteArray(raw: RouteInput[]): RoutePrice[] {
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new ConfigError(
        `routes[${index}]`,
        `routes[${index}] must be an object such as { "route": "GET /weather", "price": "$0.001" }, got ${JSON.stringify(entry)}.`,
      );
    }
    if ("route" in entry && typeof entry.route === "string") {
      const { method, path } = splitRoute(entry.route, index);
      return {
        method,
        path,
        ...normalisePrice(entry.price, `routes[${index}]`),
        ...metadata(entry),
      };
    }
    const direct = entry as RoutePrice;
    const method = assertMethod(direct.method ?? "GET", `routes[${index}]`);
    if (typeof direct.path !== "string" || direct.path.trim().length === 0) {
      throw new ConfigError(
        `routes[${index}]`,
        `routes[${index}].path is required and must start with "/".`,
      );
    }
    assertPath(direct.path, `${method} ${direct.path}`, index);
    return {
      method,
      path: direct.path,
      ...normalisePrice(direct.price, `routes[${index}]`),
      ...metadata(direct),
    };
  });
}

/** Validate a price and copy it, so callers cannot mutate config afterwards. */
function normalisePrice(
  price: RoutePrice["price"],
  at: string,
): Pick<RoutePrice, "price"> {
  if (typeof price === "string") {
    const trimmed = price.trim();
    if (trimmed.length === 0) {
      throw new ConfigError(at, `${at}.price is empty. Use a decimal such as "0.001".`);
    }
    // A "$" prefix is the SDK's USD marker; the digits after it must still be a
    // plain decimal, so strip it before checking.
    const digits = trimmed.startsWith("$") ? trimmed.slice(1).trim() : trimmed;
    if (!/^\d+(\.\d+)?$/.test(digits)) {
      throw new ConfigError(
        at,
        `${at}.price "${trimmed}" is not a decimal amount. Use digits with at most one decimal point, such as "0.001". A negative, scientific-notation or non-numeric value reaches the SDK, which throws per request — every buyer gets HTTP 500 instead of a 402.`,
      );
    }
    if (Number(digits) <= 0) {
      throw new ConfigError(
        at,
        `${at}.price "${trimmed}" is not a positive amount. A zero or negative price produces a 402 whose amount is 0, so the route is advertised as paid while charging nothing — and a negative one makes the SDK throw on every request.`,
      );
    }
    return { price: trimmed };
  }

  if (typeof price === "object" && price !== null) {
    const asset = pickString(price.asset);
    const amount = pickString(price.amount);
    if (!asset) {
      throw new ConfigError(
        at,
        `${at}.price is an asset price but has no asset. Provide the token contract address or mint.`,
      );
    }
    if (!amount) {
      throw new ConfigError(
        at,
        `${at}.price is an asset price but has no amount. Amounts are atomic units, e.g. "10000" for 0.01 of a 6-decimal token.`,
      );
    }
    if (!/^\d+$/.test(amount)) {
      throw new ConfigError(
        at,
        `${at}.price.amount "${amount}" must be atomic units — an integer string. The SDK converts "$" prices to atomic units itself, but an explicit asset price is already final.`,
      );
    }
    if (BigInt(amount) === 0n) {
      throw new ConfigError(
        at,
        `${at}.price.amount is "0". A zero amount advertises the route as paid while charging nothing; remove the route from the map instead if it should be free.`,
      );
    }
    return { price: { asset, amount } };
  }

  throw new ConfigError(
    at,
    `${at}.price must be a decimal string such as "0.001", or { asset, amount } to price in a specific token.`,
  );
}

/** Copy the optional discovery metadata, dropping empty values. */
function metadata(entry: Partial<RoutePrice>): Partial<RoutePrice> {
  const result: Partial<RoutePrice> = {};
  if (entry.description) result.description = entry.description;
  if (entry.mimeType) result.mimeType = entry.mimeType;
  if (entry.serviceName) result.serviceName = entry.serviceName;
  if (entry.iconUrl) result.iconUrl = entry.iconUrl;
  if (entry.tags && entry.tags.length > 0) result.tags = [...entry.tags];
  if (entry.maxTimeoutSeconds !== undefined) {
    result.maxTimeoutSeconds = entry.maxTimeoutSeconds;
  }
  if (entry.paymentFlow !== undefined) {
    if (entry.paymentFlow !== "authorization" && entry.paymentFlow !== "upfront") {
      throw new ConfigError(
        "routes",
        `Route "${entry.method ?? ""} ${entry.path ?? ""}".paymentFlow is ${JSON.stringify(
          entry.paymentFlow,
        )}. Use "authorization" (settle after the handler) or "upfront" (settle before it). The SDK rejects anything else at startup with a less specific message.`,
      );
    }
    result.paymentFlow = entry.paymentFlow;
  }
  if (entry.uptoFlow !== undefined) {
    if (entry.uptoFlow !== "authorization" && entry.uptoFlow !== "escrow") {
      throw new ConfigError(
        "routes",
        `Route "${entry.method ?? ""} ${entry.path ?? ""}".uptoFlow is ${JSON.stringify(
          entry.uptoFlow,
        )}. Use "authorization" for EVM or "escrow" for Solana.`,
      );
    }
    result.uptoFlow = entry.uptoFlow;
  }
  if (entry.scheme !== undefined) {
    if (entry.scheme !== "exact" && entry.scheme !== "upto") {
      throw new ConfigError(
        "routes",
        `Route "${entry.method ?? ""} ${entry.path ?? ""}".scheme is ${JSON.stringify(
          entry.scheme,
        )}. x402-lens registers "exact" and "upto"; use the returned server handle to register anything else.`,
      );
    }
    result.scheme = entry.scheme;
  }
  return result;
}

/**
 * HTTP methods a route may declare.
 *
 * `*` means any, which the adapters honour. Anything else is refused: a typo
 * like `POX /weather` was accepted and produced a lens that protected nothing.
 * The route key simply never matched a request, so the handler ran unpaid with
 * no event and no 402 — a silent revenue loss, and the hardest kind of defect to
 * notice because nothing looks broken.
 */
const KNOWN_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "*",
]);

/**
 * Validate a route method and normalise its case.
 *
 * @param raw - Method as written by the operator
 * @param at - Where it came from, for the error message
 * @returns The uppercase method
 * @throws {ConfigError} When the token is not an HTTP method this package routes
 */
function assertMethod(raw: string, at: string): string {
  const method = raw.trim().toUpperCase();
  if (!KNOWN_METHODS.has(method)) {
    throw new ConfigError(
      at,
      `${at} declares method "${raw}", which is not an HTTP method. Use GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS, or "*" for any. A route with an unrecognised method never matches a request, so the handler runs unpaid and no payment event is emitted.`,
    );
  }
  return method;
}

function splitRoute(route: string, index: number): { method: string; path: string } {
  // Trim first, but remember that `"GET "` is a method with no path, not a path
  // called "GET": trimming away the separating space silently turned one into
  // the other and produced a route nobody could ever hit.
  const trimmed = route.trim();
  if (trimmed.length === 0) {
    throw new ConfigError(`routes[${index}]`, "Route is empty. Expected a route such as \"GET /weather\".");
  }

  const spaceIndex = trimmed.indexOf(" ");
  if (spaceIndex === -1) {
    assertPath(trimmed, route, index);
    return { method: "GET", path: trimmed };
  }

  const method = assertMethod(trimmed.slice(0, spaceIndex), `routes[${index}]`);
  const path = trimmed.slice(spaceIndex + 1).trim();
  if (!path) {
    throw new ConfigError(
      `routes[${index}]`,
      `Route "${route}" has a method but no path.`,
    );
  }
  assertPath(path, route, index);
  return { method, path };
}

/** A path must be rooted, or Express cannot match it to anything. */
function assertPath(path: string, route: string, index: number): void {
  if (path.startsWith("/")) return;
  throw new ConfigError(
    `routes[${index}]`,
    `Route "${route}" resolves to path "${path}", which does not start with "/". Write it as "GET /${path}" — a route key is "<METHOD> <path>", and without the slash it silently protects nothing.`,
  );
}

interface FileConfig extends LensConfigInput {
  routes?: RoutesInput;
}

async function readConfigFile(cwd: string): Promise<FileConfig> {
  const path = `${cwd}/x402.config.json`;
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch {
    return {};
  }
  try {
    return JSON.parse(contents) as FileConfig;
  } catch (error) {
    throw new ConfigError(
      "x402.config.json",
      `x402.config.json is not valid JSON: ${(error as Error).message}`,
    );
  }
}

/**
 * Read `X402_PRICE__<METHOD>_<PATH>` variables, e.g.
 * `X402_PRICE__GET_/weather=0.001`.
 */
function routesFromEnv(env: Record<string, string | undefined>): RoutePrice[] {
  const routes: RoutePrice[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("X402_PRICE__") || !value) continue;
    const spec = key.slice("X402_PRICE__".length);
    const separator = spec.indexOf("_");
    if (separator < 1) continue;
    const method = spec.slice(0, separator).toUpperCase();
    const path = spec.slice(separator + 1);
    if (!path) continue;
    const index = routes.length;
    assertPath(path, `${method} ${path}`, index);
    routes.push({ method, path, price: value.trim() });
  }
  return routes;
}

/**
 * Build the `extra` block for one offer.
 *
 * Validation lives in `assertSchemesAreValid`, which runs during config
 * resolution so the error names the route at startup rather than surfacing as a
 * fatal SDK failure during background init.
 *
 * @param route - Route being turned into an offer
 * @param network - Network this offer is for
 * @returns The extra block, or undefined when nothing needs to be set
 */
function extraFor(route: RoutePrice, network: string): Record<string, unknown> | undefined {
  if ((route.scheme ?? "exact") === "upto") {
    const flow = route.uptoFlow ?? (network.startsWith("solana:") ? "escrow" : "authorization");
    return { paymentFlow: flow };
  }
  return route.paymentFlow ? { paymentFlow: route.paymentFlow } : undefined;
}

/** One payable option on a route, as handed to `@x402/express`. */
export interface LensPaymentOption {
  scheme: PaymentScheme;
  price: string | AssetPrice;
  network: string;
  payTo: string;
  maxTimeoutSeconds: number;
  /**
   * Forwarded to `accepts[].extra.paymentFlow`, which is where the SDK reads it.
   * Protocol-reserved, so it must be set here rather than by an extension.
   */
  extra?: Record<string, unknown>;
}

/** Route config shape accepted by `@x402/express`. */
export interface LensRouteConfig {
  accepts: LensPaymentOption[];
  description?: string;
  mimeType?: string;
  serviceName?: string;
  iconUrl?: string;
  tags?: string[];
}

/**
 * Turn configured routes into the `RoutesConfig` shape the official middleware
 * expects.
 *
 * One `accepts[]` entry per configured network, in declaration order. Decimal
 * prices get a `$` prefix so the SDK parses them as USD-pegged and resolves the
 * network's own default asset; an explicit asset price is passed through
 * untouched, because converting it would change what the buyer owes.
 *
 * Each entry carries that network's own receiving address, because an address
 * only exists on the chain it belongs to.
 *
 * @param config - Validated configuration
 * @returns Map keyed by `"<METHOD> <path>"`
 */
export function toRoutesConfig(config: LensConfig): Record<string, LensRouteConfig> {
  const networks = config.networks.length > 0 ? config.networks : [config.network];
  const routes: Record<string, LensRouteConfig> = {};

  for (const route of config.routes) {
    const key = `${route.method} ${route.path}`;
    routes[key] = {
      accepts: networks.map(network => {
        const scheme = route.scheme ?? "exact";
        return {
          scheme,
          price:
            typeof route.price === "string"
              ? route.price.startsWith("$")
                ? route.price
                : `$${route.price}`
              : { ...route.price },
          network,
          payTo: config.payToByNetwork[network] ?? config.payTo,
          maxTimeoutSeconds: route.maxTimeoutSeconds ?? config.maxTimeoutSeconds,
          ...(extraFor(route, network) ? { extra: extraFor(route, network) } : {}),
        };
      }),
      ...(route.description ? { description: route.description } : {}),
      ...(route.mimeType ? { mimeType: route.mimeType } : {}),
      ...(route.serviceName ? { serviceName: route.serviceName } : {}),
      ...(route.iconUrl ? { iconUrl: route.iconUrl } : {}),
      ...(route.tags ? { tags: [...route.tags] } : {}),
    };
  }

  return routes;
}
