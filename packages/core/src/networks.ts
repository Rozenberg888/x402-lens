/**
 * CAIP-2 network identifiers and the v1 → v2 aliases that most often break a
 * migration. Kept in one place so config validation and the findings engine
 * can never disagree.
 */

/** Namespaces we can name a canonical id for. Unknown namespaces still validate. */
const KNOWN_NAMESPACES = [
  "eip155",
  "solana",
  "algorand",
  "aptos",
  "stellar",
  "hedera",
  "xrpl",
] as const;

export type KnownNamespace = (typeof KNOWN_NAMESPACES)[number];

/** CAIP-2 is `namespace:reference`, reference is 1+ alphanumerics or `-`. */
const CAIP2_PATTERN = /^[a-z][a-z0-9]{1,31}:[A-Za-z0-9-]{1,64}$/;

export function isCaip2(value: string): boolean {
  return CAIP2_PATTERN.test(value);
}

export function namespaceOf(network: string): string | undefined {
  if (!isCaip2(network)) return undefined;
  return network.slice(0, network.indexOf(":"));
}

/** Well-known ids, useful in hints and in the CLI's `doctor` output. */
export const WELL_KNOWN_NETWORKS = {
  "eip155:8453": "Base mainnet",
  "eip155:84532": "Base Sepolia",
  "eip155:1": "Ethereum mainnet",
  "eip155:11155111": "Ethereum Sepolia",
  "eip155:43114": "Avalanche mainnet",
  "eip155:43113": "Avalanche Fuji",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "Solana mainnet",
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": "Solana devnet",
} as const satisfies Record<string, string>;

/**
 * v1 shorthand → CAIP-2. Covers the networks the official v1 SDKs shipped with
 * plus the aliases that show up in migration bug reports.
 */
export const V1_ALIASES: Record<string, string> = {
  base: "eip155:8453",
  "base-mainnet": "eip155:8453",
  "base-sepolia": "eip155:84532",
  ethereum: "eip155:1",
  mainnet: "eip155:1",
  sepolia: "eip155:11155111",
  avalanche: "eip155:43114",
  "avalanche-fuji": "eip155:43113",
  "avalanche-testnet": "eip155:43113",
  polygon: "eip155:137",
  optimism: "eip155:10",
  arbitrum: "eip155:42161",
  solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "solana-devnet": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  "solana-mainnet": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  solana_testnet: "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z",
};

/**
 * Suggest a CAIP-2 id for a value that failed validation.
 *
 * @param value - Whatever the operator supplied
 * @returns Canonical id when recognised, otherwise `undefined`
 */
export function suggestCaip2(value: string): string | undefined {
  const normalised = value.trim().toLowerCase().replace(/[\s_]+/g, "-");
  return V1_ALIASES[normalised] ?? V1_ALIASES[normalised.replace(/-mainnet$/, "")];
}

/** Human label for a network, falling back to the raw id. */
export function describeNetwork(network: string): string {
  const known = (WELL_KNOWN_NETWORKS as Record<string, string>)[network];
  return known ? `${known} (${network})` : network;
}
