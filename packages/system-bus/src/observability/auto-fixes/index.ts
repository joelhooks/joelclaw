import type { ErrorCode } from "../../../../cli/src/error-codes";
import type { RunbookPhase } from "../../../../cli/src/runbooks";
import type { OtelEvent } from "../otel-event";
import { autoCommitAndRetry } from "./auto-commit-retry";
import { ignore } from "./ignore";
import { restartWorker } from "./restart-worker";

export type AutoFixHandler = (
  event: OtelEvent
) => Promise<{ fixed: boolean; detail: string }>;

export type AutoFixDefinition = {
  handler: AutoFixHandler;
  runbookCode: ErrorCode;
  runbookPhase: RunbookPhase;
};

export const AUTO_FIX_HANDLERS = {
  autoCommitAndRetry: {
    handler: autoCommitAndRetry,
    runbookCode: "RUN_FAILED",
    runbookPhase: "fix",
  },
  ignore: {
    handler: ignore,
    runbookCode: "NO_ACTIVE_LOOP",
    runbookPhase: "diagnose",
  },
  restartWorker: {
    handler: restartWorker,
    runbookCode: "RUN_FAILED",
    runbookPhase: "fix",
  },
} satisfies Record<string, AutoFixDefinition>;

export type AutoFixHandlerName = keyof typeof AUTO_FIX_HANDLERS;
