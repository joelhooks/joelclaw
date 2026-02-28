import { emitOtelEvent } from "../../observability/emit";

export { echoFizzle } from "../../memory/echo-fizzle";
export { agentDispatch } from "./agent-dispatch";
export { agentTaskRun } from "./agent-task-run";
export {
  agentLoopComplete,
  agentLoopImplement,
  agentLoopJudge,
  agentLoopPlan,
  agentLoopRetro,
  agentLoopReview,
  agentLoopTestWriter,
} from "./agent-loop";
export { approvalRequest, approvalResolve } from "./approval";
export { backfillObserve } from "./backfill-observe";
export { bookDownload } from "./book-download";
export { channelMessageClassify } from "./channel-message-classify";
export { channelMessageIngest } from "./channel-message-ingest";
export { checkCalendar } from "./check-calendar";
export { checkEmail } from "./check-email";
export { checkGranola, granolaCheckCron } from "./check-granola";
export { checkLoops } from "./check-loops";
export { checkMemoryReview } from "./check-memory-review";
export { checkSessions } from "./check-sessions";
export {
  checkSystemHealth,
  checkSystemHealthSignalsSchedule,
} from "./check-system-health";
export { checkTriggers } from "./check-triggers";
export { checkVaultSync } from "./check-vault-sync";
export { contactEnrich } from "./contact-enrich";
export { contentReviewApply } from "./content-review";
export { contentPrune, contentSync, contentVerify } from "./content-sync";
export { dailyDigest } from "./daily-digest";
export { discoveryCapture } from "./discovery-capture";
export { docsIngest } from "./docs-ingest";
export {
  docsBacklog,
  docsBacklogDriver,
  docsEnrich,
  docsIngestJanitor,
  docsReindex,
} from "./docs-maintenance";
export { emailInboxCleanup } from "./email-cleanup";
export { embedText } from "./embed";
export { friction } from "./friction";
export { frictionFix } from "./friction-fix";
export {
  frontAssigneeChanged,
  frontMessageReceived,
  frontMessageSent,
} from "./front-notify";
export {
  githubPackagePublished,
  githubWorkflowRunCompleted,
} from "./github-notify";
export { granolaBackfill } from "./granola-backfill";
export { heartbeatCron, heartbeatWake } from "./heartbeat";
export { clusterFunctionDefinitions, clusterFunctionIds } from "./index.cluster";
export { hostFunctionDefinitions, hostFunctionIds } from "./index.host";
export { manifestArchive } from "./manifest-archive";
export { mediaProcess } from "./media-process";
export { meetingAnalyze } from "./meeting-analyze";
export { meetingTranscriptIndex } from "./meeting-transcript-index";
export { adrEvidenceCapture } from "./memory/adr-evidence-capture";
export { batchReview } from "./memory/batch-review";
export { nightlyMaintenance } from "./memory/nightly-maintenance";
export { proposalTriage } from "./memory/proposal-triage";
export { weeklyMaintenanceSummary } from "./memory/weekly-maintenance-summary";
export { nasSoakReview, nasSoakSample } from "./nas-soak";
export { networkStatusUpdate } from "./network-status-update";
export { o11yTriage } from "./o11y-triage";
export { observeSessionFunction } from "./observe";
export { observeSessionNoted } from "./observe-session-noted";
export { promote } from "./promote";
export { reflect } from "./reflect";
export { slackBackfillBatch, slackChannelBackfill } from "./slack-backfill";
export { sleepModeRequested, wakeModeRequested } from "./sleep-mode";
export { storyPipeline } from "./story-pipeline";
export { subscriptionCheckFeeds, subscriptionCheckSingle } from "./subscriptions";
export { summarize } from "./summarize";
export { systemLogger } from "./system-logger";
export { taskTriage } from "./task-triage";
export { telegramCallbackReceived } from "./telegram-callback";
export { telnyxNotify } from "./telnyx-notify";
export { todoistMemoryReviewBridge } from "./todoist-memory-review-bridge";
export {
  todoistCommentAdded,
  todoistTaskCompleted,
  todoistTaskCreated,
} from "./todoist-notify";
export { transcriptIndexWeb } from "./transcript-index-web";
export { transcriptProcess } from "./transcript-process";
export {
  typesenseBlogSync,
  typesenseFullSync,
  typesenseVaultSync,
} from "./typesense-sync";
export {
  vercelDeployCanceled,
  vercelDeployCreated,
  vercelDeployError,
  vercelDeploySucceeded,
} from "./vercel-notify";
export { videoDownload } from "./video-download";
export { vipEmailReceived } from "./vip-email-received";
export { voiceCallCompleted } from "./voice-call-completed";
export { xContentHook } from "./x-content-hook";
export { xDiscoveryHook } from "./x-discovery-hook";
export { xPost } from "./x-post";

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
