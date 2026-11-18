/**
 * The findings engine.
 *
 * Input is whatever subset of the exchange you have: the 402 challenge, the
 * payment the client sent, and the facilitator's verdicts. Output is an
 * ordered list of diagnoses with a concrete fix for each.
 *
 * Two hard rules, both from the protocol spec:
 *
 * 1. Read-only. Nothing here mutates the objects it inspects, so the engine can
 *    run against a live request or against JSON captured from production.
 * 2. Match on `invalidReason` / `errorReason` codes, never on message text.
 *    The spec says human-readable text is free-form and may change.
 */

import type { Finding, FindingCode } from "../events.js";
import { describeNetwork, suggestCaip2, isCaip2 } from "../networks.js";
import {
  asEvmExactPayload,
  isAtomicAmount,
  isSolanaAddress,
  type WirePaymentPayload,
  type WirePaymentRequired,
  type WirePaymentRequirements,
  type WireSettleResponse,
  type WireVerifyResponse,
} from "../wire.js";

/** Everything the engine may look at. All fields optional. */
export interface DiagnosisInput {
  /** Decoded `PAYMENT-REQUIRED` header from the 402. */
  paymentRequired?: WirePaymentRequired;
  /** Decoded `PAYMENT-SIGNATURE` header the client sent. */
  paymentPayload?: WirePaymentPayload;
  /** Facilitator `/verify` response. */
  verifyResponse?: WireVerifyResponse;
  /** Facilitator `/settle` response. */
  settleResponse?: WireSettleResponse;
  /** Clock override, for deterministic tests. Defaults to `Date.now()`. */
  now?: number;
}

const SEVERITY_ORDER: Record<Finding["severity"], number> = {
  error: 0,
  warn: 1,
  info: 2,
};

/**
 * Run every rule against the input and return findings, most severe first.
 *
 * @param input - Any subset of the payment exchange
 * @returns Ordered findings; empty when nothing is wrong
 */
export function diagnose(input: DiagnosisInput): Finding[] {
  const { paymentRequired } = input;
  const findings: Finding[] = [
    ...checkX402Version(input),
    ...checkAccepts(input),
    ...checkNetwork(input),
    ...checkAmount(input),
    ...checkPayTo(input),
    ...checkAsset(input),
    ...checkSolanaAsset(paymentRequired),
    ...checkEip712Domain(input),
    ...checkAuthorizationWindow(input),
    ...checkVerifyVerdict(input),
    ...checkSettlementVerdict(input),
  ];

  return findings.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.code.localeCompare(b.code),
  );
}

function finding(
  severity: Finding["severity"],
  code: FindingCode,
  field: string,
  problem: string,
  fix: string,
): Finding {
  return { severity, code, field, problem, fix };
}

/** A v1 client sends `X-PAYMENT` and `x402Version: 1`; the server rejects it. */
function checkX402Version({ paymentPayload }: DiagnosisInput): Finding[] {
  if (!paymentPayload) return [];
  if (paymentPayload.x402Version === 2) return [];
  return [
    finding(
      "error",
      "x402_version_mismatch",
      "payment.x402Version",
      `payment declares x402Version ${String(paymentPayload.x402Version)}; x402 v2 requires 2.`,
      "Set x402Version: 2 and send the payload in PAYMENT-SIGNATURE (v1 used X-PAYMENT). Upgrade @x402/* packages together — they release in lockstep.",
    ),
  ];
}

/** Without a non-empty `accepts[]` there is nothing for a client to pay. */
function checkAccepts({ paymentRequired }: DiagnosisInput): Finding[] {
  if (!paymentRequired) return [];
  const accepts = paymentRequired.accepts;
  if (Array.isArray(accepts) && accepts.length > 0) return [];
  return [
    finding(
      "error",
      "missing_accepts",
      "challenge.accepts",
      "The 402 response has no accepts[] entries, so a client cannot construct a payment.",
      "Configure at least one route with a price, network, and payTo. Check that the route pattern matches the request path exactly as served.",
    ),
  ];
}

/** Networks must be CAIP-2 and must be one of the options actually offered. */
function checkNetwork({
  paymentRequired,
  paymentPayload,
}: DiagnosisInput): Finding[] {
  const findings: Finding[] = [];
  const declared = paymentPayload?.accepted?.network ?? paymentPayload?.resource;

  if (paymentPayload) {
    const network = paymentPayload.accepted?.network;
    if (network !== undefined && !isCaip2(network)) {
      const suggestion = suggestCaip2(network);
      findings.push(
        finding(
          "error",
          "network_not_caip2",
          "payment.accepted.network",
          `payment.network "${network}" is a shorthand, not the CAIP-2 id the server matches on.`,
          suggestion
            ? `Use "${suggestion}".`
            : "Use a CAIP-2 id such as eip155:84532 or solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1.",
        ),
      );
    }

    const offered = paymentRequired?.accepts;
    if (network && Array.isArray(offered) && offered.length > 0) {
      const matches = offered.some(entry => entry.network === network);
      if (!matches) {
        const available = offered.map(entry => entry.network).join(", ");
        findings.push(
          finding(
            "error",
            "network_not_offered",
            "payment.accepted.network",
            `The client signed for "${network}", but the challenge only offers: ${available}.`,
            `Pick one of the offered networks and re-sign against that accepts[] entry — for example ${offered[0]?.network ?? "the first one"}.`,
          ),
        );
      }
    }
  } else if (declared && typeof declared === "object" && "network" in declared) {
    // Defensive: some clients echo the requirement under `resource`.
    const network = (declared as { network?: unknown }).network;
    if (typeof network === "string" && !isCaip2(network)) {
      findings.push(
        finding(
          "error",
          "network_not_caip2",
          "payment.resource.network",
          `payment.network "${network}" is not a CAIP-2 identifier.`,
          "Use a CAIP-2 id such as eip155:84532.",
        ),
      );
    }
  }

  for (const entry of paymentRequired?.accepts ?? []) {
    if (isCaip2(entry.network)) continue;
    const suggestion = suggestCaip2(entry.network);
    findings.push(
      finding(
        "error",
        "network_not_caip2",
        `challenge.accepts.network`,
        `The challenge advertises network "${entry.network}", which is not CAIP-2.${
          suggestion ? ` Clients paying ${suggestion} will not match it.` : ""
        }`,
        suggestion
          ? `Configure the route with network "${suggestion}".`
          : "Configure the route with a CAIP-2 network id.",
      ),
    );
  }

  return findings;
}

/**
 * The `accepts[]` entry the client is paying against.
 *
 * A challenge may offer several networks — a route priced in USDC on both Base
 * and Solana is the normal case — with different amounts, assets, and
 * recipients per entry. Comparing a payment against `accepts[0]` reports
 * mismatches for a correct payment that simply chose another entry, so the
 * comparison must use the entry the payload echoes.
 *
 * When the payload names no entry, a single-offer challenge is still
 * unambiguous. When it names an entry the challenge does not offer, there is
 * nothing to compare against: `network_not_offered` already reports that, and
 * adding amount/recipient findings on top would be noise about the wrong field.
 */
function selectAccept(
  paymentRequired: WirePaymentRequired | undefined,
  paymentPayload: WirePaymentPayload | undefined,
): WirePaymentRequirements | undefined {
  const offered = paymentRequired?.accepts ?? [];
  if (offered.length === 0) return undefined;

  const chosen = paymentPayload?.accepted;
  if (!chosen) return offered.length === 1 ? offered[0] : undefined;

  return offered.find(
    entry => entry.network === chosen.network && entry.scheme === chosen.scheme,
  );
}

/** Amounts on the wire are atomic-unit integer strings, never decimal tokens. */
function checkAmount({
  paymentRequired,
  paymentPayload,
}: DiagnosisInput): Finding[] {
  const findings: Finding[] = [];
  const evm = paymentPayload ? asEvmExactPayload(paymentPayload) : undefined;
  const selected = selectAccept(paymentRequired, paymentPayload);
  const advertised = selected?.amount;

  if (evm) {
    const { value } = evm.authorization;
    if (!isAtomicAmount(value)) {
      findings.push(
        finding(
          "error",
          "amount_not_atomic",
          "payment.authorization.value",
          `authorization.value "${value}" is not an integer string, so it is not atomic units.`,
          advertised
            ? `Send the amount in atomic units as an integer string, e.g. "${advertised}" for the advertised price.`
            : "Send the amount in atomic units as an integer string (10000 for 0.01 USDC with 6 decimals).",
        ),
      );
    } else if (advertised && value !== advertised) {
      findings.push(
        finding(
          "error",
          "amount_mismatch",
          "payment.authorization.value",
          `The authorization value ${value} does not match the required amount ${advertised} for ${selected?.network ?? "this route"}.`,
          `Sign exactly ${advertised} atomic units. The exact scheme rejects over- and underpayment alike.`,
        ),
      );
    }
  }

  // Every offer is served to clients, so every one of them must be atomic —
  // not just whichever entry this particular payment happened to choose.
  const offered = paymentRequired?.accepts ?? [];
  offered.forEach((entry, index) => {
    if (isAtomicAmount(entry.amount)) return;
    findings.push(
      finding(
        "error",
        "amount_not_atomic",
        `challenge.accepts[${index}].amount`,
        `The challenge advertises amount "${String(entry.amount)}", which is not an atomic-unit integer string.`,
        'Configure the route price as a decimal string such as "$0.001"; the SDK converts it to atomic units when building accepts[].',
      ),
    );
  });

  return findings;
}

/** `authorization.to` must equal the `payTo` of the entry being paid. */
function checkPayTo({
  paymentRequired,
  paymentPayload,
}: DiagnosisInput): Finding[] {
  const findings: Finding[] = [];

  // An EVM payment names its recipient inside the signed authorization.
  const evm = paymentPayload ? asEvmExactPayload(paymentPayload) : undefined;
  if (evm) {
    const selected = selectAccept(paymentRequired, paymentPayload);
    const advertised = selected?.payTo;
    if (advertised && !sameAddress(evm.authorization.to, advertised)) {
      findings.push(
        finding(
          "error",
          "pay_to_mismatch",
          "payment.authorization.to",
          `The authorization pays ${evm.authorization.to}, but the challenge requires ${advertised} for ${selected?.network ?? "this route"}.`,
          "Re-sign with the payTo from the matching accepts[] entry. If the two differ because the server changed its receiving address, request a fresh 402 and sign that.",
        ),
      );
    }
  }

  // A Solana payment carries a signed transaction whose recipient cannot be read
  // without decoding it, so compare the client's echo instead. That still catches
  // the common bug — a server advertising an address that is not valid base58 on
  // the chain it is advertised for, which no client can pay.
  findings.push(...checkSolanaRecipient(paymentRequired));

  return findings;
}

/**
 * Every Solana offer must advertise a base58 recipient.
 *
 * This is the check that would have caught a server reusing one EVM address for
 * every network: such an offer is unpayable, and the client only finds out when
 * the transaction fails to build.
 */
function checkSolanaRecipient(
  paymentRequired: WirePaymentRequired | undefined,
): Finding[] {
  const findings: Finding[] = [];
  const offered = paymentRequired?.accepts ?? [];

  offered.forEach((entry, index) => {
    if (!entry.network.startsWith("solana:")) return;
    if (entry.payTo && isSolanaAddress(entry.payTo)) return;
    findings.push(
      finding(
        "error",
        "pay_to_mismatch",
        `challenge.accepts[${index}].payTo`,
        `${describeNetwork(entry.network)} advertises recipient ${JSON.stringify(
          entry.payTo,
        )}, which is not a base58 Solana address. No client can build a transfer to it, so this offer is unpayable.`,
        `Set a base58 Solana public key for ${entry.network}. An EVM address only exists on EVM chains — configure one receiving address per network.`,
      ),
    );
  });

  return findings;
}

/**
 * A Solana mint is a base58 address, so an EVM contract address in a Solana offer
 * is a configuration error rather than a token that happens to look unusual.
 */
function checkSolanaAsset(
  paymentRequired: WirePaymentRequired | undefined,
): Finding[] {
  const findings: Finding[] = [];
  const offered = paymentRequired?.accepts ?? [];

  offered.forEach((entry, index) => {
    if (!entry.network.startsWith("solana:")) return;
    if (!entry.asset || isSolanaAddress(entry.asset)) return;
    findings.push(
      finding(
        "error",
        "asset_mismatch",
        `challenge.accepts[${index}].asset`,
        `The Solana offer advertises asset ${JSON.stringify(
          entry.asset,
        )}, which is not a base58 mint address.`,
        "Set the SPL token mint for this network, e.g. EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v for USDC on mainnet, or price the route as a \"$\" amount so the SDK resolves the mint.",
      ),
    );
  });

  return findings;
}

/** The asset in `accepts[]` must be the one the client signed against. */
function checkAsset({
  paymentRequired,
  paymentPayload,
}: DiagnosisInput): Finding[] {
  const accepted = paymentPayload?.accepted;
  if (!accepted?.asset) return [];
  const advertised = paymentRequired?.accepts?.find(
    entry => entry.network === accepted.network && entry.scheme === accepted.scheme,
  );
  if (!advertised?.asset) return [];
  if (accepted.asset === advertised.asset) return [];

  return [
    finding(
      "error",
      "asset_mismatch",
      "payment.accepted.asset",
      `The payment is signed against asset ${accepted.asset}, but the challenge requires ${advertised.asset}.`,
      "Use the asset from the challenge verbatim. On EVM this is the token contract address; it is also the EIP-712 verifyingContract, so a mismatch invalidates the signature too.",
    ),
  ];
}

/**
 * The EIP-712 domain must be complete, because a missing or wrong field makes
 * every signature invalid in a way the facilitator reports only as
 * "invalid signature".
 *
 * An EVM `exact` payment signs an EIP-3009 `TransferWithAuthorization` against a
 * domain built from four values. Two of them come from `extra` on the accepted
 * requirement, one from the network's chain id, and one is the asset address.
 * When `extra.name` or `extra.version` is absent the client cannot build the
 * domain at all — the usual outcome is a signature that recovers to a different
 * address, and an operator who cannot tell why.
 *
 * This is a warning rather than an error: some tokens publish a domain the
 * facilitator knows out of band, so an absent `extra` is suspicious, not
 * certainly fatal. A value that is present but the wrong type is an error.
 */
function checkEip712Domain({
  paymentRequired,
  paymentPayload,
}: DiagnosisInput): Finding[] {
  const accepted = paymentPayload?.accepted;
  // Only EVM exact payments carry an EIP-712 domain.
  const evm = paymentPayload ? asEvmExactPayload(paymentPayload) : undefined;
  const network = accepted?.network ?? paymentRequired?.accepts?.[0]?.network;
  if (!network || !network.startsWith("eip155:")) return [];
  if (paymentPayload && !evm) return [];
  if (!paymentRequired && !paymentPayload) return [];

  const offered = paymentRequired?.accepts ?? [];
  const source =
    offered.find(
      entry => entry.network === accepted?.network && entry.scheme === accepted?.scheme,
    ) ??
    offered.find(entry => entry.scheme === (accepted?.scheme ?? "exact")) ??
    offered[0] ??
    accepted;
  if (!source) return [];

  const findings: Finding[] = [];
  const extra = source.extra ?? {};
  const name = extra.name;
  const version = extra.version;
  const domain = `EIP-712 domain on ${describeNetwork(network)} (chain id ${
    network.slice("eip155:".length)
  }, verifyingContract ${source.asset || "unset"})`;

  if (typeof name !== "string" || name.length === 0) {
    findings.push(
      finding(
        "warn",
        "eip712_domain_mismatch",
        "challenge.accepts.extra.name",
        `${domain} has no token name, so a client cannot build the domain it must sign against.`,
        'Set accepts[].extra.name to the token name (usually "USDC"). The SDK reads it from the network\'s default asset when the price is a "$" amount, so seeing it missing usually means the route was priced with an explicit asset the SDK does not recognise.',
      ),
    );
  }

  if (version !== undefined && typeof version !== "string") {
    findings.push(
      finding(
        "error",
        "eip712_domain_mismatch",
        "challenge.accepts.extra.version",
        "The EIP-712 domain version is not a plain string.",
        'Set accepts[].extra.version to the string the token uses, usually "2".',
      ),
    );
  } else if (version === undefined) {
    findings.push(
      finding(
        "warn",
        "eip712_domain_mismatch",
        "challenge.accepts.extra.version",
        `${domain} has no version, so a client must guess whether the token signs "1" or "2".`,
        'Set accepts[].extra.version to "2" (the EIP-3009 default) unless the token documents another value.',
      ),
    );
  }

  return findings;
}

/** `validAfter` / `validBefore` are absolute unix seconds. */
function checkAuthorizationWindow({  paymentPayload,
  now = Date.now(),
}: DiagnosisInput): Finding[] {
  const evm = paymentPayload ? asEvmExactPayload(paymentPayload) : undefined;
  if (!evm) return [];

  const nowSeconds = Math.floor(now / 1000);
  const findings: Finding[] = [];
  const { validAfter, validBefore } = evm.authorization;

  const after = Number.parseInt(validAfter, 10);
  if (Number.isFinite(after) && nowSeconds < after) {
    findings.push(
      finding(
        "error",
        "authorization_not_yet_valid",
        "payment.authorization.validAfter",
        `The authorization becomes valid at ${new Date(after * 1000).toISOString()}, which is in the future.`,
        "Set validAfter to now (or slightly in the past) and re-sign.",
      ),
    );
  }

  const before = Number.parseInt(validBefore, 10);
  if (Number.isFinite(before) && nowSeconds >= before) {
    findings.push(
      finding(
        "error",
        "authorization_expired",
        "payment.authorization.validBefore",
        `The authorization expired at ${new Date(before * 1000).toISOString()}, before it reached the server.`,
        "Request a fresh 402 and sign again with a later validBefore. Do not retry an expired payload — the facilitator will reject it every time.",
      ),
    );
  }

  return findings;
}

/**
 * Map a facilitator verify verdict onto a diagnosis.
 *
 * The code list is the spec's plus the ones facilitators actually return in
 * practice. Anything unmapped still produces a finding, so an unfamiliar code
 * is never silently swallowed.
 */
function checkVerifyVerdict({
  verifyResponse,
  paymentPayload,
  paymentRequired,
}: DiagnosisInput): Finding[] {
  if (!verifyResponse || verifyResponse.isValid) return [];
  const reason = verifyResponse.invalidReason ?? "unknown";
  const rawMessage = verifyResponse.invalidMessage?.trim();
  const detail = rawMessage
    ? ` Facilitator said: ${rawMessage.length > 200 ? `${rawMessage.slice(0, 200)}…` : rawMessage}`
    : "";

  switch (reason) {
    case "invalid_exact_evm_payload_signature":
      return [
        finding(
          "error",
          "signature_mismatch",
          "payment.payload.signature",
          `The signature does not recover to the payer address.${detail}`,
          eip712Hint(paymentPayload, paymentRequired),
        ),
      ];
    case "invalid_exact_evm_payload_authorization_value_mismatch":
    case "invalid_exact_evm_payload_authorization_value":
    case "amount_too_low":
      return [
        finding(
          "error",
          "amount_mismatch",
          "payment.payload.authorization.value",
          `The signed amount is not the required amount.${detail}`,
          "Sign exactly the amount from accepts[], in atomic units.",
        ),
      ];
    case "invalid_exact_evm_payload_recipient_mismatch":
      return [
        finding(
          "error",
          "pay_to_mismatch",
          "payment.payload.authorization.to",
          `The signed recipient is not the route's payTo.${detail}`,
          "Re-sign against the payTo in accepts[].",
        ),
      ];
    case "invalid_exact_evm_payload_authorization_valid_before":
      return [
        finding(
          "error",
          "authorization_expired",
          "payment.payload.authorization.validBefore",
          `The authorization expired before settlement.${detail}`,
          "Request a fresh 402 and re-sign with a later validBefore.",
        ),
      ];
    case "invalid_exact_evm_payload_authorization_valid_after":
      return [
        finding(
          "error",
          "authorization_not_yet_valid",
          "payment.payload.authorization.validAfter",
          `The authorization is not valid yet.${detail}`,
          "Set validAfter to now or earlier and re-sign.",
        ),
      ];
    case "invalid_network":
      return [
        finding(
          "error",
          "network_not_offered",
          "payment.accepted.network",
          `The facilitator does not support this network for this route.${detail}`,
          "Check GET /supported on the facilitator and register a scheme for a network it lists with x402Version 2.",
        ),
      ];
    case "invalid_payload":
      return [
        finding(
          "error",
          "x402_version_mismatch",
          "payment.payload",
          `The payload is malformed or reuses a spent authorization.${detail}`,
          "Check the protocol version (v1 X-PAYMENT against a v2 server produces exactly this), keep @x402/* package versions in lockstep, and never replay a nonce.",
        ),
      ];
    default:
      return [
        finding(
          "warn",
          "signature_mismatch",
          "verify.invalidReason",
          `Verification failed with "${reason}".${detail}`,
          "Check the facilitator's error-code reference for this code; if it is unmapped here, report it so the rule can be added.",
        ),
      ];
  }
}

/**
 * Settlement failures are distinct from verification failures: funds may have
 * moved (or be in flight), so the advice is about reconciliation, not re-signing.
 */
function checkSettlementVerdict({
  settleResponse,
}: DiagnosisInput): Finding[] {
  if (!settleResponse || settleResponse.success) return [];
  const reason = settleResponse.errorReason ?? "unknown";
  const tx = settleResponse.transaction;

  if (reason === "settlement_pending") {
    return [
      finding(
        "warn",
        "settlement_pending",
        "settlement.transaction",
        `The transaction was broadcast${
          tx ? ` (${tx})` : ""
        } but its confirmation could not be established. This is non-terminal: it may still confirm.`,
        "Run `x402-lens reconcile --tx <hash>` before retrying. Do not treat the 402 as a rejection and do not place a second payment — that risks charging the buyer twice.",
      ),
    ];
  }

  return [
    finding(
      "error",
      "settlement_failed",
      "settlement.errorReason",
      `Settlement failed with "${reason}"${tx ? ` (transaction ${tx})` : ""}.`,
      "Treat this as failed, not as pending. If a transaction hash is present, run `x402-lens reconcile --tx <hash>` before letting the buyer retry.",
    ),
  ];
}

function eip712Hint(
  paymentPayload: WirePaymentPayload | undefined,
  paymentRequired: WirePaymentRequired | undefined,
): string {
  // The challenge is the authority: it carries the extra.name/version the server
  // signs against. A payload's `accepted` is the client's echo and may be stale
  // or wrong, which is often why verification failed in the first place.
  const offered = paymentRequired?.accepts ?? [];
  const accepted = paymentPayload?.accepted;
  const matched =
    offered.find(
      entry =>
        entry.network === accepted?.network && entry.scheme === accepted?.scheme,
    ) ??
    offered.find(entry => entry.scheme === accepted?.scheme) ??
    offered[0];
  const source = matched ?? accepted;

  const extra = source?.extra ?? {};
  const name = typeof extra.name === "string" ? `"${extra.name}"` : "the token name";
  const version = typeof extra.version === "string" ? `"${extra.version}"` : "2";
  const asset = source?.asset ?? "the token contract address";
  const network = source?.network ?? accepted?.network ?? "the route network";

  return `Rebuild the EIP-712 domain from extra.name (${name}), extra.version (${version}), the chain id of ${describeNetwork(
    network,
  )}, and verifyingContract = ${asset}. Then sign with the same account as authorization.from.`;
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
