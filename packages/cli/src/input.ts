/**
 * Reading x402 wire objects from arguments.
 *
 * Everything a developer pastes into a debugging session arrives in one of
 * three shapes: raw base64, base64 in an `@file`, or already-decoded JSON. All
 * three are supported so nobody has to transform a header by hand.
 */

import { readFile } from "node:fs/promises";

/** Raised when an argument cannot be decoded. */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

/**
 * Decode an argument into a JSON value.
 *
 * Accepts `@path` (read the file), raw JSON, or base64-encoded JSON. The order
 * matters: JSON is tried first because a base64 string is never valid JSON, so
 * a JSON-looking value never falls through to the base64 branch.
 *
 * @param raw - The argument value
 * @param label - Argument name, used in error messages
 * @returns The parsed value
 * @throws {InputError} When nothing can be parsed
 */
export async function readJsonArgument(raw: string, label: string): Promise<unknown> {
  const source = raw.startsWith("@") ? await readFile(raw.slice(1), "utf8") : raw;
  return parseJsonOrBase64(source, label);
}

/**
 * Parse a string that is either JSON or base64-encoded JSON.
 *
 * @param source - Raw string
 * @param label - Name used in error messages
 * @returns The parsed value
 * @throws {InputError} When neither form parses
 */
export function parseJsonOrBase64(source: string, label: string): unknown {
  const trimmed = source.trim();
  if (trimmed.length === 0) {
    throw new InputError(`${label} is empty.`);
  }

  const asJson = tryParseJson(trimmed);
  if (asJson !== undefined) return asJson;

  const decoded = tryDecodeBase64(trimmed);
  if (decoded !== undefined) {
    const fromBase64 = tryParseJson(decoded);
    if (fromBase64 !== undefined) return fromBase64;
    throw new InputError(
      `${label} decodes from base64 but the result is not JSON. Got: ${decoded.slice(0, 120)}`,
    );
  }

  throw new InputError(
    `${label} is neither JSON nor base64-encoded JSON. Pass the header value verbatim, or JSON, or @file.`,
  );
}

function tryParseJson(value: string): unknown | undefined {
  const first = value[0];
  if (first !== "{" && first !== "[" && first !== '"') return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function tryDecodeBase64(value: string): string | undefined {
  const normalised = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalised.padEnd(
    normalised.length + ((4 - (normalised.length % 4)) % 4),
    "=",
  );
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(padded)) return undefined;
  try {
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    // Base64 of binary decodes to replacement characters; reject that.
    return decoded.includes("\uFFFD") ? undefined : decoded;
  } catch {
    return undefined;
  }
}
