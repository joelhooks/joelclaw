import { capturePrefixGrowthAlert, typesenseStartupBudgetCheck } from "./typesense-recovery-alerts";
import { meetingTranscriptIndex } from "./meeting-transcript-index";
import { memoryRunCaptured } from "./memory/run-captured";
import { transcriptIndexWeb } from "./transcript-index-web";

/** CPU-heavy local session/transcript indexing stays off the host HTTP worker. */
export const memoryIndexerFunctionDefinitions = [
  memoryRunCaptured,
  meetingTranscriptIndex,
  transcriptIndexWeb,
  capturePrefixGrowthAlert,
  typesenseStartupBudgetCheck,
];

function getFunctionId(fn: { opts?: { id?: string } }): string {
  return fn.opts?.id ?? "unknown";
}

export const memoryIndexerFunctionIds = memoryIndexerFunctionDefinitions.map(getFunctionId);
