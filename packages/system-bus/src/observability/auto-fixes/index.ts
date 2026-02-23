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

const AUTO_FIX_HANDLER_ALIASES: Record<string, AutoFixHandlerName> = {
  auto_commit_and_retry: "autoCommitAndRetry",
  "auto-commit-and-retry": "autoCommitAndRetry",
  autocommitandretry: "autoCommitAndRetry",
  restart_worker: "restartWorker",
  "restart-worker": "restartWorker",
  restartworker: "restartWorker",
};

export function resolveAutoFixHandlerName(value: unknown): AutoFixHandlerName | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  if (Object.prototype.hasOwnProperty.call(AUTO_FIX_HANDLERS, trimmed)) {
    return trimmed as AutoFixHandlerName;
  }

  return AUTO_FIX_HANDLER_ALIASES[trimmed.toLowerCase()] ?? null;
}
