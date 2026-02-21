import { videoDownload } from "./video-download";
import { transcriptProcess } from "./transcript-process";
import { transcriptIndexWeb } from "./transcript-index-web";
import { summarize } from "./summarize";
import { systemLogger } from "./system-logger";
import { observeSessionFunction } from "./observe";
import { reflect } from "./reflect";
import { contentSync } from "./content-sync";
import { discoveryCapture } from "./discovery-capture";
import { promote } from "./promote";
import { embedText } from "./embed";
import { backfillObserve } from "./backfill-observe";
import { heartbeatCron, heartbeatWake } from "./heartbeat";
import { agentDispatch } from "./agent-dispatch";
import { mediaProcess } from "./media-process";
import {
  agentLoopPlan,
  agentLoopTestWriter,
  agentLoopImplement,
  agentLoopReview,
  agentLoopJudge,
  agentLoopComplete,
  agentLoopRetro,
} from "./agent-loop";
import {
  vercelDeploySucceeded,
  vercelDeployError,
  vercelDeployCreated,
  vercelDeployCanceled,
} from "./vercel-notify";
import { emailInboxCleanup } from "./email-cleanup";
import { meetingAnalyze } from "./meeting-analyze";
import { granolaBackfill } from "./granola-backfill";
import { friction } from "./friction";
import { frictionFix } from "./friction-fix";
import { telnyxNotify } from "./telnyx-notify";
import { proposalTriage } from "./memory/proposal-triage";
import { batchReview } from "./memory/batch-review";
import { nightlyMaintenance } from "./memory/nightly-maintenance";
import { weeklyMaintenanceSummary } from "./memory/weekly-maintenance-summary";
import { echoFizzle } from "../../memory/echo-fizzle";
import { taskTriage } from "./task-triage";
import { checkSessions } from "./check-sessions";
import { checkTriggers } from "./check-triggers";
import { checkSystemHealth } from "./check-system-health";
import { networkStatusUpdate } from "./network-status-update";
import { checkMemoryReview } from "./check-memory-review";
import { checkVaultSync } from "./check-vault-sync";
import { checkGranola } from "./check-granola";
import { checkEmail } from "./check-email";
import { vipEmailReceived } from "./vip-email-received";
import { checkCalendar } from "./check-calendar";
import { checkLoops } from "./check-loops";
import { o11yTriage } from "./o11y-triage";
import { dailyDigest } from "./daily-digest";
import {
  typesenseVaultSync,
  typesenseBlogSync,
  typesenseFullSync,
} from "./typesense-sync";
import { nasSoakSample, nasSoakReview } from "./nas-soak";

function getFunctionId(fn: { opts?: { id?: string } }): string {
  return fn.opts?.id ?? "unknown";
}

// ADR-0089: Transitional role split.
// Until cluster-safe ownership is finalized, host worker remains authoritative.
export const hostFunctionDefinitions = [
  videoDownload,
  transcriptProcess,
  transcriptIndexWeb,
  summarize,
  systemLogger,
  observeSessionFunction,
  reflect,
  contentSync,
  discoveryCapture,
  promote,
  embedText,
  backfillObserve,
  heartbeatCron,
  heartbeatWake,
  agentDispatch,
  agentLoopPlan,
  agentLoopTestWriter,
  agentLoopImplement,
  agentLoopReview,
  agentLoopJudge,
  agentLoopComplete,
  agentLoopRetro,
  mediaProcess,
  vercelDeploySucceeded,
  vercelDeployError,
  vercelDeployCreated,
  vercelDeployCanceled,
  emailInboxCleanup,
  meetingAnalyze,
  granolaBackfill,
  friction,
  frictionFix,
  telnyxNotify,
  proposalTriage,
  batchReview,
  nightlyMaintenance,
  weeklyMaintenanceSummary,
  echoFizzle,
  taskTriage,
  checkSessions,
  checkTriggers,
  checkSystemHealth,
  networkStatusUpdate,
  checkMemoryReview,
  checkVaultSync,
  checkGranola,
  checkEmail,
  vipEmailReceived,
  checkCalendar,
  checkLoops,
  o11yTriage,
  dailyDigest,
  typesenseVaultSync,
  typesenseBlogSync,
  typesenseFullSync,
  nasSoakSample,
  nasSoakReview,
];

export const hostFunctionIds = hostFunctionDefinitions.map(getFunctionId);
