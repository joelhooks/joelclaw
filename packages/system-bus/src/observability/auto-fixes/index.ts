import type { OtelEvent } from "../otel-event";
import { autoCommitAndRetry } from "./auto-commit-retry";
import { ignore } from "./ignore";
import { restartWorker } from "./restart-worker";

export type AutoFixHandler = (
  event: OtelEvent
) => Promise<{ fixed: boolean; detail: string }>;

export const AUTO_FIX_HANDLERS: Record<string, AutoFixHandler> = {
  autoCommitAndRetry,
  ignore,
  restartWorker,
};
