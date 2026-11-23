/**
 * `x402-lens doctor` — check that a configuration can actually accept payments.
 *
 * Three things break a deployment before a single buyer arrives: a network the
 * facilitator does not support, a missing or wrong-shaped receiving address, and
 * a facilitator that is simply unreachable. All three are checkable up front.
 */

import {
  ConfigError,
  WELL_KNOWN_NETWORKS,
  describeNetwork,
  isCaip2,
  loadConfig,
  suggestCaip2,
  type LensConfig,
} from "@x402-lens/core";

export interface DoctorOptions {
  /** Config to check. When absent, it is loaded from env and `x402.config.json`. */
  config?: LensConfig;
  /** Directory used to resolve `x402.config.json`. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Override the facilitator to probe. */
  facilitatorUrl?: string;
  /** Override the network to verify against `/supported`. */
  network?: string;
  /** Override the full network list. Wins over `network` when present. */
  networks?: string[];
  /** Fetch timeout, milliseconds. */
  timeoutMs?: number;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  exitCode: number;
  text: string;
}

interface SupportedResponse {
  kinds?: Array<{ x402Version?: number; scheme?: string; network?: string }>;
  extensions?: string[];
  signers?: Record<string, string[]>;
}

/**
 * Run every configuration check that does not require a buyer.
 *
 * @param options - Config and probe overrides
 * @returns Individual checks, a rendered report, and an exit code
 */
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];

  let config: LensConfig | undefined;
  let configError: Error | undefined;
  try {
    config =
      options.config ??
      (await loadConfig({
        readConfigFile: true,
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      }));
    checks.push({
      name: "config",
      ok: true,
      detail: `facilitator ${config.facilitatorUrl}, network ${
        config.networks.length > 1
          ? config.networks.map(describeNetwork).join(", ")
          : describeNetwork(config.network)
      }, ${config.routes.length} route(s)`,
    });
    checks.push(checkFacilitatorHeadersOk(config));
  } catch (error) {
    configError = error as Error;
    if (isFacilitatorHeadersConfigError(configError)) {
      checks.push({
        name: "facilitatorHeaders",
        ok: false,
        detail: configError.message,
      });
      // Do not continue with facilitator overrides: a bad header shape is a
      // deploy blocker even when --facilitator / --network are supplied.
      return finish(checks);
    }
  }

  const facilitatorUrl = (
    options.facilitatorUrl ??
    config?.facilitatorUrl ??
    ""
  ).replace(/\/+$/, "");
  // An explicit network override replaces the list rather than adding to it:
  // `--network` asks a question about one chain, not about the deployment.
  const networks =
    options.networks ??
    (options.network ? [options.network] : (config?.networks ?? []));
  const network = networks[0] ?? "";

  if (!config) {
    if (!facilitatorUrl || !network) {
      checks.push({
        name: "config",
        ok: false,
        detail: configError?.message ?? "Configuration could not be loaded.",
      });
      return finish(checks);
    }
    // Overrides supplied enough to probe the facilitator; the rest is reported.
    checks.push({
      name: "config",
      ok: true,
      detail:
        "Probing with facilitator and network overrides. Full configuration (payTo, routes) was not loaded, so it was not checked.",
    });
  }

  if (!isCaip2(network)) {
    const suggestion = suggestCaip2(network);
    checks.push({
      name: "network format",
      ok: false,
      detail: `"${network}" is not CAIP-2.${suggestion ? ` Use "${suggestion}".` : ""}`,
    });
    return finish(checks);
  }
  checks.push({
    name: "network format",
    ok: true,
    detail: describeNetwork(network),
  });

  if (config) {
    for (const net of networks.length > 0 ? networks : config.networks) {
      const address = config.payToByNetwork[net] ?? config.payTo;
      checks.push(checkPayToShape(address, net));
    }
  }

  let supported: SupportedResponse | undefined;
  try {
    const authHeaders = config?.facilitatorHeaders?.supported ?? {};
    const response = await fetch(`${facilitatorUrl}/supported`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "x402-lens/0.2",
        ...authHeaders,
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
    if (!response.ok) {
      // A 401/403 is not an outage and not a configuration mistake this tool
      // can see: the facilitator is up and is asking for credentials. Reporting
      // it as "reachable: false" sends the operator to check the URL and the
      // network, where nothing is wrong. CDP's facilitator answers 401 without
      // an API key, which makes this the first thing a CDP user hits.
      const needsAuth = response.status === 401 || response.status === 403;
      checks.push({
        name: needsAuth ? "facilitator auth" : "facilitator reachable",
        ok: false,
        detail: needsAuth
          ? `GET ${facilitatorUrl}/supported returned HTTP ${response.status}: the facilitator is up but requires credentials. Configure facilitatorHeaders.supported (for example an Authorization bearer token or x-api-key/x-user-key pair) and re-run.`
          : `GET ${facilitatorUrl}/supported returned HTTP ${response.status}.`,
      });
      return finish(checks);
    }
    supported = (await response.json()) as SupportedResponse;
    checks.push({
      name: "facilitator reachable",
      ok: true,
      detail: `${facilitatorUrl}/supported responded with ${String(supported.kinds?.length ?? 0)} kind(s).`,
    });
  } catch (error) {
    checks.push({
      name: "facilitator reachable",
      ok: false,
      detail: `Could not reach ${facilitatorUrl}/supported: ${(error as Error).message}. Check the URL, the network path, and any proxy in between.`,
    });
    return finish(checks);
  }

  const kinds = supported.kinds ?? [];
  const matching = kinds.filter(
    kind => kind.network === network && kind.x402Version === 2,
  );

  if (matching.length === 0) {
    const v1Only = kinds.some(kind => kind.network === network && kind.x402Version === 1);
    const available = Array.from(
      new Set(kinds.filter(kind => kind.x402Version === 2).map(kind => kind.network ?? "")),
    ).filter(Boolean);
    checks.push({
      name: "network supported",
      ok: false,
      detail: v1Only
        ? `The facilitator lists ${network} for x402Version 1 only. This middleware speaks v2, so payments will be rejected.`
        : `The facilitator does not list ${network} with x402Version 2. It supports: ${available.join(", ") || "nothing"}.`,
    });
  } else {
    checks.push({
      name: "network supported",
      ok: true,
      detail: `${network} is available for scheme(s): ${matching.map(kind => kind.scheme ?? "?").join(", ")}.`,
    });
  }

  // Every configured network is validated by the SDK at startup, and a missing
  // one is fatal: `@x402/core` calls process.exit(1) from its background init,
  // which kills the server rather than returning a 402. Checking all of them
  // here is the only place that failure can be caught before a deploy.
  const missing = networks.filter(
    candidate =>
      !kinds.some(kind => kind.network === candidate && kind.x402Version === 2),
  );
  if (networks.length > 1) {
    checks.push(
      missing.length === 0
        ? {
            name: "all networks supported",
            ok: true,
            detail: `All ${networks.length} configured networks are listed for x402Version 2: ${networks.join(", ")}.`,
          }
        : {
            name: "all networks supported",
            ok: false,
            detail: `These configured networks are not listed for x402Version 2: ${missing.join(
              ", ",
            )}. The SDK treats this as a fatal startup error and exits the process, so the server will not start. Remove them from networks, or use a facilitator that supports them.`,
          },
    );
  }

  const requiredSchemes = Array.from(
    new Set(
      (config?.routes ?? []).map(route => route.scheme ?? "exact"),
    ),
  );
  // No loaded routes: keep the historical exact check so a facilitator-only
  // probe still answers the common default.
  const schemesToCheck = requiredSchemes.length > 0 ? requiredSchemes : ["exact"];
  const networksForSchemes = networks.length > 0 ? networks : [network];
  for (const scheme of schemesToCheck) {
    const missingSchemeNetworks = networksForSchemes.filter(
      candidate =>
        !kinds.some(
          kind =>
            kind.network === candidate &&
            kind.x402Version === 2 &&
            kind.scheme === scheme,
        ),
    );
    const schemeOk = missingSchemeNetworks.length === 0;
    checks.push({
      name: `${scheme} scheme`,
      ok: schemeOk,
      detail: schemeOk
        ? networksForSchemes.length > 1
          ? `The facilitator supports the ${scheme} scheme on all configured networks.`
          : `The facilitator supports the ${scheme} scheme on this network.`
        : `Configured routes use the ${scheme} scheme, which is not listed for: ${missingSchemeNetworks.join(", ")}.`,
    });
  }

  if (WELL_KNOWN_NETWORKS[network as keyof typeof WELL_KNOWN_NETWORKS]) {
    checks.push({
      name: "known network",
      ok: true,
      detail: `${describeNetwork(network)} — widely deployed, safe for production.`,
    });
  } else {
    checks.push({
      name: "known network",
      ok: true,
      detail: `${network} is not in the built-in list. That is fine if you intended it; verify token and facilitator support yourself.`,
    });
  }

  return finish(checks);
}

function isFacilitatorHeadersConfigError(error: Error): error is ConfigError {
  return error instanceof ConfigError && error.field === "facilitatorHeaders";
}

/**
 * Report that auth headers are either absent or already in the per-path shape
 * `resolveConfig` accepts. Flat objects and file-based secrets never reach here.
 */
function checkFacilitatorHeadersOk(config: LensConfig): DoctorCheck {
  if (!config.facilitatorHeaders) {
    return {
      name: "facilitatorHeaders",
      ok: true,
      detail:
        "No facilitatorHeaders set (public facilitator or X402_FACILITATOR_TOKEN unset).",
    };
  }
  return {
    name: "facilitatorHeaders",
    ok: true,
    detail:
      "facilitatorHeaders use the per-path shape (verify/settle/supported), not a flat object.",
  };
}

/** Cheap shape check: EVM addresses are 0x + 40 hex, SVM are base58. */
function checkPayToShape(payTo: string, network: string): DoctorCheck {
  const namespace = network.slice(0, network.indexOf(":"));

  if (namespace === "eip155") {
    const ok = /^0x[0-9a-fA-F]{40}$/.test(payTo);
    return {
      name: "payTo address",
      ok,
      detail: ok
        ? `${payTo} looks like an EVM address.`
        : `"${payTo}" is not a 0x-prefixed 20-byte address, which ${describeNetwork(network)} requires.`,
    };
  }

  if (namespace === "solana") {
    const ok = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(payTo);
    return {
      name: "payTo address",
      ok,
      detail: ok
        ? `${payTo} looks like a base58 Solana address.`
        : `"${payTo}" is not a base58 public key, which ${describeNetwork(network)} requires.`,
    };
  }

  return {
    name: "payTo address",
    ok: payTo.length > 0,
    detail: `No format check available for namespace "${namespace}". Confirm the address format with the network's tooling.`,
  };
}

function finish(checks: DoctorCheck[]): DoctorResult {
  const failed = checks.filter(check => !check.ok);
  const lines = checks.map(check => `${check.ok ? "ok  " : "FAIL"}  ${check.name}: ${check.detail}`);

  // "Fix the FAIL lines" is wrong for an auth failure: the operator cannot fix
  // a 401 by editing a URL, they have to obtain a credential. Saying otherwise
  // sends them looking for a mistake that is not there.
  const needsCredential = failed.some(check => check.name === "facilitator auth");
  const summary =
    failed.length === 0
      ? "\nAll checks passed."
      : needsCredential
        ? `\n${failed.length} check(s) failed. The facilitator is up but rejected the request — obtain credentials for it, then re-run.`
        : `\n${failed.length} check(s) failed. Fix the FAIL lines above; every one of them prevents real payments.`;

  return {
    checks,
    exitCode: failed.length === 0 ? 0 : 1,
    text: [...lines, summary].join("\n"),
  };
}
