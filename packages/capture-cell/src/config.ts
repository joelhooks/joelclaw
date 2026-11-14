import { homedir } from "node:os";
import { join } from "node:path";
import { resolveOtelEmitUrl, resolveSystemId } from "./otel";

export const DEFAULT_READ_TIMEOUT_MS = 3_000;
export const DEFAULT_WAL_STOP_BYTES = 2 * 1024 ** 3;
export const DEFAULT_TICK_MS = 5_000;
export const DEFAULT_OTEL_TIMEOUT_MS = 5_000;
/** Shadow verdicts younger than this may predate the writer's append. */
export const COMPARE_RECHECK_MS = 10 * 60_000;
export const AGE_ALERT_MS = 15 * 60_000;

export interface CellConfig {
  /** Only cell mode writes sessions.db; off/both retain shadow behavior. */
  mode: "off" | "both" | "cell";
  outboxPath: string;
  sessionsDbPath: string;
  readTimeoutMs: number;
  walStopBytes: number;
  tickMs: number;
  port: number | undefined;
  token: string | undefined;
  otel: { url: string | undefined; token: string | undefined; timeoutMs: number; systemId: string };
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): CellConfig {
  const port = Number(env.CAPTURE_CELL_PORT);
  return {
    mode:
      env.CAPTURE_CELL_MODE === "cell" ? "cell" : env.CAPTURE_CELL_MODE === "both" ? "both" : "off",
    outboxPath: expandHome(
      env.CAPTURE_CELL_DB?.trim() || join(homedir(), ".joelclaw", "capture-cell", "outbox.db"),
    ),
    sessionsDbPath: expandHome(
      env.SESSION_INDEX_PATH?.trim() || join(homedir(), ".joelclaw", "search", "sessions.db"),
    ),
    readTimeoutMs: positiveInt(env.CAPTURE_CELL_READ_TIMEOUT_MS, DEFAULT_READ_TIMEOUT_MS),
    walStopBytes: positiveInt(env.CAPTURE_CELL_WAL_STOP_BYTES, DEFAULT_WAL_STOP_BYTES),
    tickMs: positiveInt(env.CAPTURE_CELL_TICK_MS, DEFAULT_TICK_MS),
    port: Number.isSafeInteger(port) && port > 0 && port < 65_536 ? port : undefined,
    token: env.CAPTURE_CELL_TOKEN?.trim() || undefined,
    otel: {
      url: resolveOtelEmitUrl(env),
      token: env.OTEL_EMIT_TOKEN?.trim() || undefined,
      timeoutMs: positiveInt(env.CAPTURE_CELL_OTEL_TIMEOUT_MS, DEFAULT_OTEL_TIMEOUT_MS),
      systemId: resolveSystemId(env),
    },
  };
}
