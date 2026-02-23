import { videoDownload } from "./video-download";
import { transcriptProcess } from "./transcript-process";
import { transcriptIndexWeb } from "./transcript-index-web";
import { summarize } from "./summarize";
import { systemLogger } from "./system-logger";
import { observeSessionFunction } from "./observe";
import { reflect } from "./reflect";
import { contentSync } from "./content-sync";
import { contentReviewSubmitted } from "./content-review";
import { discoveryCapture } from "./discovery-capture";
import { promote } from "./promote";
import { embedText } from "./embed";
import { backfillObserve } from "./backfill-observe";
import { heartbeatCron, heartbeatWake } from "./heartbeat";
import { agentDispatch } from "./agent-dispatch";
import { mediaProcess } from "./media-process";
import { telegramCallbackReceived } from "./telegram-callback";
import { voiceCallCompleted } from "./voice-call-completed";
import { observeSessionNoted } from "./observe-session-noted";
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
import { adrEvidenceCapture } from "./memory/adr-evidence-capture";
import { echoFizzle } from "../../memory/echo-fizzle";
import { taskTriage } from "./task-triage";
import { checkSessions } from "./check-sessions";
import { checkTriggers } from "./check-triggers";
import {
  checkSystemHealth,
  checkSystemHealthSignalsSchedule,
} from "./check-system-health";
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
  typesenseVaultSyncQueue,
  typesenseVaultSync,
  typesenseBlogSync,
  typesenseFullSync,
} from "./typesense-sync";
import { nasSoakSample, nasSoakReview } from "./nas-soak";
import {
  backupTypesense,
  backupRedis,
  rotateSessions,
  rotateOtel,
  rotateLogs,
} from "./nas-backup";
import { manifestArchive } from "./manifest-archive";
import { docsIngest } from "./docs-ingest";
import { docsEnrich, docsReindex } from "./docs-maintenance";

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
  contentReviewSubmitted,
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
  telegramCallbackReceived,
  voiceCallCompleted,
  observeSessionNoted,
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
  adrEvidenceCapture,
  echoFizzle,
  taskTriage,
  checkSessions,
  checkTriggers,
  checkSystemHealth,
  checkSystemHealthSignalsSchedule,
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
  typesenseVaultSyncQueue,
  typesenseVaultSync,
  typesenseBlogSync,
  typesenseFullSync,
  nasSoakSample,
  nasSoakReview,
  backupTypesense,
  backupRedis,
  rotateSessions,
  rotateOtel,
  rotateLogs,
  manifestArchive,
  docsIngest,
  docsEnrich,
  docsReindex,
];

export const hostFunctionIds = hostFunctionDefinitions.map(getFunctionId);
