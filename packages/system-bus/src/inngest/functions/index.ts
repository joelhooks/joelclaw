import { emitOtelEvent } from "../../observability/emit";

export { videoDownload } from "./video-download";
export { transcriptProcess } from "./transcript-process";
export { summarize } from "./summarize";
export { systemLogger } from "./system-logger";
export { observeSessionFunction } from "./observe";
export { reflect } from "./reflect";
export { contentSync } from "./content-sync";
export { discoveryCapture } from "./discovery-capture";
export { promote } from "./promote";
export { embedText } from "./embed";
export { agentDispatch } from "./agent-dispatch";
export { backfillObserve } from "./backfill-observe";
export { heartbeatCron, heartbeatWake } from "./heartbeat";
export { approvalRequest, approvalResolve } from "./approval";
export { taskTriage } from "./task-triage";
export { checkSessions } from "./check-sessions";
export { checkTriggers } from "./check-triggers";
export { checkSystemHealth } from "./check-system-health";
export { networkStatusUpdate } from "./network-status-update";
export { checkMemoryReview } from "./check-memory-review";
export { checkVaultSync } from "./check-vault-sync";
export { checkGranola } from "./check-granola";
export { checkEmail } from "./check-email";
export { checkCalendar } from "./check-calendar";
export { checkLoops } from "./check-loops";
export { vipEmailReceived } from "./vip-email-received";
export { dailyDigest } from "./daily-digest";
export { mediaProcess } from "./media-process";
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
export { emailInboxCleanup } from "./email-cleanup";
export { meetingAnalyze } from "./meeting-analyze";
export { granolaBackfill } from "./granola-backfill";
export { friction } from "./friction";
export { frictionFix } from "./friction-fix";
export { telnyxNotify } from "./telnyx-notify";
export { proposalTriage } from "./memory/proposal-triage";
export { batchReview } from "./memory/batch-review";
export { nightlyMaintenance } from "./memory/nightly-maintenance";
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
