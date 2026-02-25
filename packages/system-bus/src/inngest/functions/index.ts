import { emitOtelEvent } from "../../observability/emit";

export { videoDownload } from "./video-download";
export { transcriptProcess } from "./transcript-process";
export { transcriptIndexWeb } from "./transcript-index-web";
export { summarize } from "./summarize";
export { systemLogger } from "./system-logger";
export { observeSessionFunction } from "./observe";
export { reflect } from "./reflect";
export { contentSync } from "./content-sync";
export { contentReviewSubmitted } from "./content-review";
export { discoveryCapture } from "./discovery-capture";
export { xPost } from "./x-post";
export { xContentHook } from "./x-content-hook";
export { xDiscoveryHook } from "./x-discovery-hook";
export { promote } from "./promote";
export { embedText } from "./embed";
export { agentDispatch } from "./agent-dispatch";
export { backfillObserve } from "./backfill-observe";
export { heartbeatCron, heartbeatWake } from "./heartbeat";
export { approvalRequest, approvalResolve } from "./approval";
export { taskTriage } from "./task-triage";
export { checkSessions } from "./check-sessions";
export { checkTriggers } from "./check-triggers";
export {
  checkSystemHealth,
  checkSystemHealthSignalsSchedule,
} from "./check-system-health";
export { networkStatusUpdate } from "./network-status-update";
export { checkMemoryReview } from "./check-memory-review";
export { checkVaultSync } from "./check-vault-sync";
export { checkGranola, granolaCheckCron } from "./check-granola";
export { checkEmail } from "./check-email";
export { checkCalendar } from "./check-calendar";
export { checkLoops } from "./check-loops";
export { subscriptionCheckFeeds, subscriptionCheckSingle } from "./subscriptions";
export { o11yTriage } from "./o11y-triage";
export { vipEmailReceived } from "./vip-email-received";
export { dailyDigest } from "./daily-digest";
export { sleepModeRequested, wakeModeRequested } from "./sleep-mode";
export { mediaProcess } from "./media-process";
export { telegramCallbackReceived } from "./telegram-callback";
export { voiceCallCompleted } from "./voice-call-completed";
export { observeSessionNoted } from "./observe-session-noted";
export {
  todoistCommentAdded,
  todoistTaskCompleted,
  todoistTaskCreated,
} from "./todoist-notify";
export { todoistMemoryReviewBridge } from "./todoist-memory-review-bridge";
export {
  frontMessageReceived,
  frontMessageSent,
  frontAssigneeChanged,
} from "./front-notify";
export {
  vercelDeploySucceeded,
  vercelDeployError,
  vercelDeployCreated,
  vercelDeployCanceled,
} from "./vercel-notify";
export {
  githubWorkflowRunCompleted,
  githubPackagePublished,
} from "./github-notify";
export { emailInboxCleanup } from "./email-cleanup";
export { meetingAnalyze } from "./meeting-analyze";
export { meetingTranscriptIndex } from "./meeting-transcript-index";
export { granolaBackfill } from "./granola-backfill";
export { friction } from "./friction";
export { frictionFix } from "./friction-fix";
export { telnyxNotify } from "./telnyx-notify";
export { proposalTriage } from "./memory/proposal-triage";
export { batchReview } from "./memory/batch-review";
export { nightlyMaintenance } from "./memory/nightly-maintenance";
export { weeklyMaintenanceSummary } from "./memory/weekly-maintenance-summary";
export { adrEvidenceCapture } from "./memory/adr-evidence-capture";
export { echoFizzle } from "../../memory/echo-fizzle";
export {
  agentLoopPlan,
  agentLoopTestWriter,
  agentLoopImplement,
  agentLoopReview,
  agentLoopJudge,
  agentLoopComplete,
  agentLoopRetro,
} from "./agent-loop";
export {
  typesenseVaultSync,
  typesenseBlogSync,
  typesenseFullSync,
} from "./typesense-sync";
export { nasSoakSample, nasSoakReview } from "./nas-soak";
export { manifestArchive } from "./manifest-archive";
export { bookDownload } from "./book-download";
export { docsIngest } from "./docs-ingest";
export {
  docsBacklog,
  docsBacklogDriver,
  docsEnrich,
  docsIngestJanitor,
  docsReindex,
} from "./docs-maintenance";
export { slackChannelBackfill, slackBackfillBatch } from "./slack-backfill";
export { contactEnrich } from "./contact-enrich";
export { hostFunctionDefinitions, hostFunctionIds } from "./index.host";
export { clusterFunctionDefinitions, clusterFunctionIds } from "./index.cluster";

export async function emitInngestRegistryLoaded(functionIds: string[]): Promise<void> {
  await emitOtelEvent({
    level: "info",
    source: "worker",
    component: "inngest.functions",
    action: "registry.loaded",
    success: true,
    metadata: {
      count: functionIds.length,
      functionIds,
    },
  });
}
