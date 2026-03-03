export * from "./capabilities"
export { createJoelclawClient, JoelclawClient } from "./client"
export { JoelclawCapabilityError, JoelclawEnvelopeError, JoelclawProcessError } from "./errors"
export { callMcpTool, fetchMailApi, getAgentMailUrl } from "./lib/agent-mail"
export type { ErrorRunbook, RunbookCommand, RunbookErrorCode, RunbookPhase } from "./runbooks"
export {
  getRunbook,
  listRunbookCodes,
  RUNBOOK_ERROR_CODES,
  RUNBOOKS,
  resolveRunbookCommand,
  resolveRunbookPhase,
} from "./runbooks"

export type {
  DeployWorkerOptions,
  JoelclawClientOptions,
  JoelclawEnv,
  JoelclawEnvelope,
  JoelclawNextAction,
  JoelclawNextActionParam,
  JoelclawRunOptions,
  JoelclawTransport,
  LogWriteInput,
  NotifyPriority,
  NotifySendInput,
  OtelEmitInput,
  OtelEventLevel,
  OtelListOptions,
  OtelSearchOptions,
  RecallBudget,
  RecallQueryOptions,
  SecretsAuditOptions,
  SecretsEnvOptions,
  SecretsLeaseInput,
  SecretsRevokeOptions,
  VaultAdrListOptions,
  VaultAdrRankOptions,
  VaultSearchOptions,
} from "./types"
