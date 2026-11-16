/**
 * Human-readable rendering of findings.
 *
 * The point of x402-lens is that an operator can answer "why did this request
 * fail" without opening the SDK. That means the text output has to be legible
 * on its own, and the JSON output has to round-trip.
 */

import type { Finding, LensEvent } from "./events.js";

/** Single-line summary: severity, code, and the problem. */
export function formatFindingLine(finding: Finding): string {
  return `[${finding.severity}] ${finding.code} (${finding.field}): ${finding.problem}`;
}

/** Multi-line block with the fix on its own line. */
export function formatFinding(finding: Finding): string {
  return [
    `${severityBadge(finding.severity)} ${finding.code}`,
    `  field:   ${finding.field}`,
    `  problem: ${finding.problem}`,
    `  fix:     ${finding.fix}`,
  ].join("\n");
}

export function formatFindings(findings: Finding[]): string {
  if (findings.length === 0) return "No problems found.";
  return findings.map(formatFinding).join("\n\n");
}

/** Compact one-line rendering of an event, suitable for a log stream. */
export function formatEventLine(event: LensEvent): string {
  const parts = [
    event.ts,
    event.type.replace("payment.", "").toUpperCase(),
    event.route,
    `${event.amount} ${event.asset}`,
    event.network,
  ];
  if (event.buyer) parts.push(`payer=${event.buyer}`);
  if (event.type === "payment.settled") parts.push(`tx=${event.txHash}`);
  if (event.type === "payment.failed") parts.push(`reason=${event.reason}`);
  if (event.type === "payment.settle_failed") parts.push(`reason=${event.reason}`);
  if (event.durationMs !== undefined) parts.push(`${event.durationMs}ms`);
  const line = parts.join(" | ");

  const findings = event.findings ?? [];
  if (findings.length === 0) return line;
  return [line, ...findings.map(f => `  → ${formatFindingLine(f)}`)].join("\n");
}

function severityBadge(severity: Finding["severity"]): string {
  switch (severity) {
    case "error":
      return "ERROR";
    case "warn":
      return "WARN ";
    case "info":
      return "INFO ";
    default: {
      const _exhaustive: never = severity;
      return _exhaustive;
    }
  }
}
