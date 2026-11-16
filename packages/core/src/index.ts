/**
 * `@x402-lens/core` — framework-agnostic building blocks.
 *
 * Nothing in here knows about Express, or about `@x402/core`. That keeps the
 * diagnostics usable against captured JSON, in a test, or from the CLI.
 */

export type {
  CancelReason,
  Finding,
  FindingCode,
  LensEvent,
  LensEventBase,
  LensEventType,
  PaymentEventType,
  SettlePhase,
} from "./events.js";
export { makeEvent } from "./events.js";

export type {
  WireEvmAuthorization,
  WireEvmExactPayload,
  WirePaymentPayload,
  WirePaymentRequired,
  WirePaymentRequirements,
  WireSettleResponse,
  WireSvmExactPayload,
  WireVerifyResponse,
} from "./wire.js";
export {
  asEvmExactPayload,
  asSvmExactPayload,
  isAtomicAmount,
  isCaip2Network,
  isSolanaAddress,
  isSvmExactPayload,
} from "./wire.js";

export type { DiagnosisInput } from "./findings/rules.js";
export { diagnose } from "./findings/rules.js";

export {
  formatEventLine,
  formatFinding,
  formatFindingLine,
  formatFindings,
} from "./format.js";

export type { LensSink } from "./sinks.js";
export { EventBus, callbackSink, consoleSink, jsonlFileSink } from "./sinks.js";

export type {
  AssetPrice,
  FacilitatorHeaders,
  LensConfig,
  LensConfigInput,
  LensPaymentOption,
  LensRouteConfig,
  LoadConfigOptions,
  PayToInput,
  PaymentFlow,
  ResolveConfigInput,
  RouteInput,
  RoutePrice,
} from "./config.js";
export { ConfigError, loadConfig, resolveConfig, toRoutesConfig } from "./config.js";

export {
  V1_ALIASES,
  WELL_KNOWN_NETWORKS,
  describeNetwork,
  isCaip2,
  namespaceOf,
  suggestCaip2,
} from "./networks.js";

export type { ConformanceIssue, CorsReport } from "./conformance.js";
export {
  checkCors,
  validatePayloadAgainstChallenge,
  validatePaymentRequired,
} from "./conformance.js";
