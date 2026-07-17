import { createVideoFunctions } from "joelclaw-video";
import { echoFizzle } from "../../memory/echo-fizzle";
import { inngest } from "../client";
import { adrDailyPitch, adrPitchApproved, adrPitchRejected } from "./adr-daily-pitch";
import { adrPitchExecute } from "./adr-pitch-execute";
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
import { agentUsageScan } from "./agent-usage-scan";
import { backfillObserve } from "./backfill-observe";
import { bookDownload } from "./book-download";
import { channelMessageClassify } from "./channel-message-classify";
import { channelMessageIngest } from "./channel-message-ingest";
import { channelIntelligenceGarden } from "./channels/channel-intelligence-garden";
import { channelIntelligenceTodoist } from "./channels/channel-intelligence-todoist";
import { checkCalendar } from "./check-calendar";
import { checkEmail } from "./check-email";
import { checkGatewayHealth } from "./check-gateway-health";
import { checkGranola, granolaCheckCron } from "./check-granola";
import { checkLoops } from "./check-loops";
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
import { conversationAnnotate } from "./conversation-annotate";
import { conversationThreadAggregate } from "./conversation-thread-aggregate";
import { conversationThreadEnrich } from "./conversation-thread-enrich";
import { conversationThreadStaleSweep } from "./conversation-thread-stale-sweep";
import { dailyDigest } from "./daily-digest";
import { dailyTokenUsageReport } from "./daily-token-usage-report";
import { discoveryCapture } from "./discovery-capture";
import { docsIngest } from "./docs-ingest";
import {
  docsBacklog,
  docsBacklogDriver,
  docsEnrich,
  docsIngestJanitor,
  docsReindex,
} from "./docs-maintenance";
import { docsReindexBatch } from "./docs-reindex-batch";
import { docsReindexV2 } from "./docs-reindex-v2";
import { emailNag } from "./email-nag";
import { embedText } from "./embed";
import { friction } from "./friction";
import { frictionFix } from "./friction-fix";
import {
  frontAssigneeChanged,
  frontMessageReceived,
  frontMessageSent,
} from "./front-notify";
import { gatewayBehaviorDailyReview } from "./gateway-behavior-review";
import { gatewayHandleMessage } from "./gateway-handle-message";
import { gatewaySendMessage } from "./gateway-send-message";
import { granolaBackfill } from "./granola-backfill";
import { heartbeatCron, heartbeatWake } from "./heartbeat";
import { knowledgeTurnWrite } from "./knowledge-turn-write";
import { knowledgeWatchdog } from "./knowledge-watchdog";
import { manifestArchive } from "./manifest-archive";
import { mediaProcess } from "./media-process";
import { mediaTranscriptionPipeline } from "./media-transcription-pipeline";
import { meetingAnalyze } from "./meeting-analyze";
import { meetingTranscriptIndex } from "./meeting-transcript-index";
import { adrEvidenceCapture } from "./memory/adr-evidence-capture";
import { batchReview } from "./memory/batch-review";
import { memoryEmbed } from "./memory/embed";
import { nightlyMaintenance } from "./memory/nightly-maintenance";
import { proposalTriage } from "./memory/proposal-triage";
import { memoryRunCaptured } from "./memory/run-captured";
import { weeklyMaintenanceSummary } from "./memory/weekly-maintenance-summary";
import {
  messageReactionBridge,
  neatMemoryReactionGrade,
} from "./message-reactions";
import {
  backupFailureRouter,
  backupRedis,
  backupTypesense,
  rotateLogs,
  rotateOtel,
  rotateSessions,
  verifyAgentSessionCaptureBackups,
} from "./nas-backup";
import { nasSoakReview, nasSoakSample } from "./nas-soak";
import { networkStatusUpdate } from "./network-status-update";
import { noiseRateGuard } from "./noise-rate-guard";
import { o11yTriage } from "./o11y-triage";
import { observeSessionNoted } from "./observe-session-noted";
import { paneSchedule } from "./pane-schedule";
import { promote } from "./promote";
import { reflect } from "./reflect";
import { selfHealingGatewayBridge } from "./self-healing-gateway-bridge";
import { selfHealingInngestRuntime } from "./self-healing-inngest-runtime";
import { selfHealingInvestigator } from "./self-healing-investigator";
import { selfHealingRouter } from "./self-healing-router";
import { signalReminder } from "./signal-reminder";
import { skillGarden } from "./skill-garden";
import { slackBackfillBatch, slackChannelBackfill } from "./slack-backfill";
import { sleepModeRequested, wakeModeRequested } from "./sleep-mode";
import { storyPipeline } from "./story-pipeline";
import { subscriptionCheckFeeds, subscriptionCheckSingle } from "./subscriptions";
import { summarize, summarizeLegacyAlias } from "./summarize";
import { systemLogger } from "./system-logger";
import { taskTriage } from "./task-triage";
import { telegramCallbackReceived } from "./telegram-callback";
import { telnyxNotify } from "./telnyx-notify";
import { transcriptIndexWeb } from "./transcript-index-web";
import { transcriptProcess, transcriptProcessLegacyAlias } from "./transcript-process";
import { transcriptionAsrChunkRun } from "./transcription-asr-chunk";
import { transcriptionCleanup } from "./transcription-cleanup";
import { transcriptionDiarizeRun } from "./transcription-diarize";
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
import { videoDownload, videoDownloadLegacyAlias } from "./video-download";
import { vipEmailThreadsBackfill } from "./vip-email-backfill";
import { vipEmailReceived } from "./vip-email-received";
import { vipEmailBrief } from "./vip-morning-brief";
import { voiceCallCompleted } from "./voice-call-completed";
import { voiceCallJudge } from "./voice-call-judge";
import { voiceMissedCall } from "./voice-missed-call";
import { voicePublicCallAnalyze } from "./voice-public-call-analyze";
import { voicePublicSmsReply } from "./voice-public-sms-reply";
import { voiceSmsVettingCheck } from "./voice-sms-vetting-check";
import { voiceSyntheticCall } from "./voice-synthetic-call";
import { voiceTelnyxBalance } from "./voice-telnyx-balance";
import { voiceWorkerCanary } from "./voice-worker-canary";
import { webhookSubscriptionDispatchGeneric } from "./webhook-subscription-dispatch-generic";
import { wikiEditionBuild } from "./wiki-edition-build";
import { xAccountActivityReceived } from "./x-account-activity-notify";
import { xContentHook } from "./x-content-hook";
import { xDiscoveryHook } from "./x-discovery-hook";
import { xPost } from "./x-post";

const videoFunctionDefinitions = createVideoFunctions(inngest);

function getFunctionId(fn: { opts?: { id?: string } }): string {
  return fn.opts?.id ?? "unknown";
}

// ADR-0089: Transitional role split.
// Until cluster-safe ownership is finalized, host worker remains authoritative.
export const hostFunctionDefinitions = [
  adrDailyPitch,
  adrPitchApproved,
  adrPitchExecute,
  adrPitchRejected,
  gatewaySendMessage,
  gatewayHandleMessage,
  gatewayBehaviorDailyReview,
  videoDownload,
  videoDownloadLegacyAlias,
  ...videoFunctionDefinitions,
  webhookSubscriptionDispatchGeneric,
  transcriptProcess,
  transcriptProcessLegacyAlias,
  transcriptIndexWeb,
  summarize,
  summarizeLegacyAlias,
  systemLogger,
  reflect,
  contentSync,
  contentVerify,
  contentPrune,
  contentReviewApply,
  conversationAnnotate,
  conversationThreadAggregate,
  conversationThreadEnrich,
  conversationThreadStaleSweep,
  discoveryCapture,
  xPost,
  xContentHook,
  xDiscoveryHook,
  xAccountActivityReceived,
  promote,
  embedText,
  backfillObserve,
  heartbeatCron,
  heartbeatWake,
  agentDispatch,
  agentTaskRun,
  agentUsageScan,
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
  mediaTranscriptionPipeline,
  transcriptionAsrChunkRun,
  transcriptionDiarizeRun,
  transcriptionCleanup,
  telegramCallbackReceived,
  voiceCallCompleted,
  voiceCallJudge,
  voicePublicCallAnalyze,
  voicePublicSmsReply,
  voiceMissedCall,
  voiceSmsVettingCheck,
  voiceSyntheticCall,
  voiceTelnyxBalance,
  voiceWorkerCanary,
  observeSessionNoted,
  vercelDeploySucceeded,
  vercelDeployError,
  vercelDeployCreated,
  vercelDeployCanceled,
  meetingAnalyze,
  meetingTranscriptIndex,
  messageReactionBridge,
  neatMemoryReactionGrade,
  granolaBackfill,
  friction,
  frictionFix,
  frontMessageReceived,
  frontMessageSent,
  frontAssigneeChanged,
  telnyxNotify,
  proposalTriage,
  batchReview,
  nightlyMaintenance,
  weeklyMaintenanceSummary,
  adrEvidenceCapture,
  memoryEmbed,
  memoryRunCaptured,
  echoFizzle,
  taskTriage,
  checkSessions,
  checkTriggers,
  checkSystemHealth,
  checkSystemHealthSignalsSchedule,
  networkStatusUpdate,
  noiseRateGuard,
  checkVaultSync,
  checkGranola,
  granolaCheckCron,
  checkEmail,
  emailNag,
  checkGatewayHealth,
  vipEmailThreadsBackfill,
  vipEmailReceived,
  vipEmailBrief,
  checkCalendar,
  checkLoops,
  subscriptionCheckFeeds,
  subscriptionCheckSingle,
  o11yTriage,
  selfHealingInvestigator,
  selfHealingRouter,
  selfHealingGatewayBridge,
  selfHealingInngestRuntime,
  dailyDigest,
  dailyTokenUsageReport,
  wikiEditionBuild,
  sleepModeRequested,
  wakeModeRequested,
  paneSchedule,
  signalReminder,
  typesenseVaultSyncQueue,
  typesenseVaultSync,
  typesenseBlogSync,
  typesenseFullSync,
  knowledgeTurnWrite,
  knowledgeWatchdog,
  nasSoakSample,
  nasSoakReview,
  backupTypesense,
  backupRedis,
  backupFailureRouter,
  verifyAgentSessionCaptureBackups,
  rotateSessions,
  rotateOtel,
  rotateLogs,
  manifestArchive,
  bookDownload,
  docsBacklog,
  docsBacklogDriver,
  docsIngest,
  docsReindexBatch,
  docsReindexV2,
  docsEnrich,
  channelIntelligenceGarden,
  channelIntelligenceTodoist,
  channelMessageIngest,
  channelMessageClassify,
  slackBackfillBatch,
  slackChannelBackfill,
  docsIngestJanitor,
  docsReindex,
  contactEnrich,
  skillGarden,
];

export const hostFunctionIds = hostFunctionDefinitions.map(getFunctionId);
