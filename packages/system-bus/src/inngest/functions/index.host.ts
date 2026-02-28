import { echoFizzle } from "../../memory/echo-fizzle";
import { agentChainRun } from "./agent-chain-run";
import { agentDispatch } from "./agent-dispatch";
import {
  agentLoopComplete,
  agentLoopImplement,
  agentLoopJudge,
  agentLoopPlan,
  agentLoopRetro,
  agentLoopReview,
  agentLoopTestWriter,
} from "./agent-loop";
import { agentTaskRun } from "./agent-task-run";
import { backfillObserve } from "./backfill-observe";
import { bookDownload } from "./book-download";
import { channelMessageClassify } from "./channel-message-classify";
import { channelMessageIngest } from "./channel-message-ingest";
import { checkCalendar } from "./check-calendar";
import { checkEmail } from "./check-email";
import { checkGranola, granolaCheckCron } from "./check-granola";
import { checkLoops } from "./check-loops";
import { checkMemoryReview } from "./check-memory-review";
import { checkSessions } from "./check-sessions";
import {
  checkSystemHealth,
  checkSystemHealthSignalsSchedule,
} from "./check-system-health";
import { checkTriggers } from "./check-triggers";
import { checkVaultSync } from "./check-vault-sync";
import { contactEnrich } from "./contact-enrich";
import { contentReviewApply } from "./content-review";
import { contentPrune, contentSync, contentVerify } from "./content-sync";
import { dailyDigest } from "./daily-digest";
import { discoveryCapture } from "./discovery-capture";
import { docsIngest } from "./docs-ingest";
import {
  docsBacklog,
  docsBacklogDriver,
  docsEnrich,
  docsIngestJanitor,
  docsReindex,
} from "./docs-maintenance";
import { emailInboxCleanup } from "./email-cleanup";
import { embedText } from "./embed";
import { friction } from "./friction";
import { frictionFix } from "./friction-fix";
import { granolaBackfill } from "./granola-backfill";
import { heartbeatCron, heartbeatWake } from "./heartbeat";
import { manifestArchive } from "./manifest-archive";
import { mediaProcess } from "./media-process";
import { meetingAnalyze } from "./meeting-analyze";
import { meetingTranscriptIndex } from "./meeting-transcript-index";
import { adrEvidenceCapture } from "./memory/adr-evidence-capture";
import { batchReview } from "./memory/batch-review";
import { nightlyMaintenance } from "./memory/nightly-maintenance";
import { proposalTriage } from "./memory/proposal-triage";
import { weeklyMaintenanceSummary } from "./memory/weekly-maintenance-summary";
import {
  backupFailureRouter,
  backupRedis,
  backupTypesense,
  rotateLogs,
  rotateOtel,
  rotateSessions,
} from "./nas-backup";
import { nasSoakReview, nasSoakSample } from "./nas-soak";
import { networkStatusUpdate } from "./network-status-update";
import { o11yTriage } from "./o11y-triage";
import { observeSessionFunction } from "./observe";
import { observeSessionNoted } from "./observe-session-noted";
import { promote } from "./promote";
import { reflect } from "./reflect";
import { selfHealingGatewayBridge } from "./self-healing-gateway-bridge";
import { selfHealingInvestigator } from "./self-healing-investigator";
import { selfHealingRouter } from "./self-healing-router";
import { skillGarden } from "./skill-garden";
import { sleepModeRequested, wakeModeRequested } from "./sleep-mode";
import { storyPipeline } from "./story-pipeline";
import { subscriptionCheckFeeds, subscriptionCheckSingle } from "./subscriptions";
import { summarize } from "./summarize";
import { systemLogger } from "./system-logger";
import { taskTriage } from "./task-triage";
import { telegramCallbackReceived } from "./telegram-callback";
import { telnyxNotify } from "./telnyx-notify";
import { transcriptIndexWeb } from "./transcript-index-web";
import { transcriptProcess } from "./transcript-process";
import {
  typesenseBlogSync,
  typesenseFullSync,
  typesenseVaultSync,
  typesenseVaultSyncQueue,
} from "./typesense-sync";
import {
  vercelDeployCanceled,
  vercelDeployCreated,
  vercelDeployError,
  vercelDeploySucceeded,
} from "./vercel-notify";
import { videoDownload } from "./video-download";
import { vipEmailReceived } from "./vip-email-received";
import { voiceCallCompleted } from "./voice-call-completed";
import { xContentHook } from "./x-content-hook";
import { xDiscoveryHook } from "./x-discovery-hook";
import { xPost } from "./x-post";

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
  contentVerify,
  contentPrune,
  contentReviewApply,
  discoveryCapture,
  xPost,
  xContentHook,
  xDiscoveryHook,
  promote,
  embedText,
  backfillObserve,
  heartbeatCron,
  heartbeatWake,
  agentDispatch,
  agentTaskRun,
  agentChainRun,
  storyPipeline,
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
  meetingTranscriptIndex,
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
  granolaCheckCron,
  checkEmail,
  vipEmailReceived,
  checkCalendar,
  checkLoops,
  subscriptionCheckFeeds,
  subscriptionCheckSingle,
  o11yTriage,
  selfHealingInvestigator,
  selfHealingRouter,
  selfHealingGatewayBridge,
  dailyDigest,
  sleepModeRequested,
  wakeModeRequested,
  typesenseVaultSyncQueue,
  typesenseVaultSync,
  typesenseBlogSync,
  typesenseFullSync,
  nasSoakSample,
  nasSoakReview,
  backupTypesense,
  backupRedis,
  backupFailureRouter,
  rotateSessions,
  rotateOtel,
  rotateLogs,
  manifestArchive,
  bookDownload,
  docsBacklog,
  docsBacklogDriver,
  docsIngest,
  docsEnrich,
  channelMessageIngest,
  channelMessageClassify,
  docsIngestJanitor,
  docsReindex,
  contactEnrich,
  skillGarden,
];

export const hostFunctionIds = hostFunctionDefinitions.map(getFunctionId);
