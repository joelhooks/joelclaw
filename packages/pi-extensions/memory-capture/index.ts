/**
 * ADR-0243 Rule 8: joelclaw memory-capture extension for pi.
 *
 * Mirrors the claude-code Stop hook (scripts/joelclaw-capture-session.ts):
 *   - Fires on every `turn_end`
 *   - Captures only the NEW bytes in the session jsonl since last capture
 *   - POSTs to Central at /api/runs with parent_run_id pointing at the
 *     prior captured Run (Rule 3: Runs form trees via parent_run_id)
 *   - Never throws; never blocks pi's continuation
 *   - Outboxes to ~/.joelclaw/outbox/ on network failure
 *
 * State:
 *   ~/.joelclaw/session-state.json[<sessionId>] = { last_byte_offset, last_run_id, ... }
 *
 * Also fires a final capture on `session_shutdown` to catch any trailing
 * bytes written after the last turn_end.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const CENTRAL_URL = process.env.JOELCLAW_CENTRAL_URL ?? "http://127.0.0.1:3111";
const AUTH_PATH = process.env.JOELCLAW_AUTH_PATH ?? join(homedir(), ".joelclaw", "auth.json");
const STATE_PATH = join(homedir(), ".joelclaw", "session-state.json");
const OUTBOX_DIR = join(homedir(), ".joelclaw", "outbox");
const LOG_PATH = join(homedir(), ".joelclaw", "capture.log");
const RUNTIME = "pi";
const DEFAULT_HTTP_TIMEOUT_MS = 2_000;
const HTTP_TIMEOUT_MS = positiveInteger(
  process.env.JOELCLAW_CAPTURE_HTTP_TIMEOUT_MS,
  DEFAULT_HTTP_TIMEOUT_MS,
);

type CaptureParams = {
  sessionId: string;
  sessionFile: string;
  trigger: "turn_end" | "session_shutdown";
};

type CaptureWorker = {
  pending: CaptureParams | undefined;
  running: Promise<void>;
};

const captureWorkers = new Map<string, CaptureWorker>();
let stateCommitQueue = Promise.resolve();

interface AuthFile {
  user_id: string;
  machine_id: string;
  token: string;
}
interface SessionState {
  last_byte_offset: number;
  last_run_id: string | null;
  last_captured_at: string;
  turn_count: number;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function log(message: string) {
  void (async () => {
    try {
      await mkdir(dirname(LOG_PATH), { recursive: true });
      const line = `[${new Date().toISOString()}] [pi] ${message}\n`;
      await appendFile(LOG_PATH, line, { mode: 0o600 });
    } catch {
      // swallow; never break pi
    }
  })();
}

async function loadAuth(): Promise<AuthFile | null> {
  try {
    const auth = JSON.parse(await readFile(AUTH_PATH, "utf8")) as AuthFile;
    if (!auth.token || !auth.user_id || !auth.machine_id) return null;
    return auth;
  } catch {
    return null;
  }
}
async function loadAllState(): Promise<Record<string, SessionState>> {
  try {
    return JSON.parse(await readFile(STATE_PATH, "utf8")) as Record<string, SessionState>;
  } catch {
    return {};
  }
}
async function saveAllState(state: Record<string, SessionState>): Promise<boolean> {
  const temporaryPath = `${STATE_PATH}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(STATE_PATH), { recursive: true });
    await writeFile(temporaryPath, JSON.stringify(state, null, 2));
    await rename(temporaryPath, STATE_PATH);
    return true;
  } catch (err) {
    log(`save state failed: ${(err as Error).message}`);
    await unlink(temporaryPath).catch(() => undefined);
    return false;
  }
}
async function commitSessionState(sessionId: string, next: SessionState): Promise<boolean> {
  let saved = false;
  stateCommitQueue = stateCommitQueue
    .catch(() => undefined)
    .then(async () => {
      const all = await loadAllState();
      all[sessionId] = next;
      saved = await saveAllState(all);
    });
  await stateCommitQueue;
  return saved;
}
function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
function sourceIdentity(machineId: string, sessionId: string, sessionFile: string): string {
  return `sha256:${sha256(JSON.stringify([RUNTIME, machineId, sessionId, sessionFile]))}`;
}
function pendingOutboxPath(identity: string, fromOffset: number): string {
  return join(OUTBOX_DIR, `pending-${sha256(`${identity}:${fromOffset}`).slice(0, 26)}.json`);
}
async function pendingBody(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
async function writeToOutbox(path: string, body: unknown): Promise<string> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await mkdir(OUTBOX_DIR, { recursive: true });
    await writeFile(temporaryPath, JSON.stringify(body));
    await rename(temporaryPath, path);
    return path;
  } catch (err) {
    log(`outbox write failed: ${(err as Error).message}`);
    await unlink(temporaryPath).catch(() => undefined);
    return "";
  }
}
async function clearPending(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log(`pending outbox cleanup failed: ${(err as Error).message}`);
    }
  }
}
function newRunId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 26);
}
function countAssistantTurns(jsonlDelta: string): number {
  let turns = 0;
  for (const line of jsonlDelta.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as {
        type?: string;
        message?: { role?: string };
      };
      if (entry.type === "message" && entry.message?.role === "assistant") {
        turns += 1;
      }
    } catch {
      // tolerate malformed lines
    }
  }
  return turns;
}

function scheduleCapture(params: CaptureParams): Promise<void> {
  const existing = captureWorkers.get(params.sessionId);
  if (existing) {
    existing.pending = params;
    return existing.running;
  }

  const worker: CaptureWorker = {
    pending: params,
    running: Promise.resolve(),
  };
  captureWorkers.set(params.sessionId, worker);
  worker.running = Promise.resolve()
    .then(async () => {
      while (worker.pending) {
        const next = worker.pending;
        worker.pending = undefined;
        try {
          await captureDeltaUnsafe(next);
        } catch (err) {
          log(`capture worker failed session=${next.sessionId}: ${(err as Error).message}`);
        }
      }
    })
    .finally(() => {
      if (captureWorkers.get(params.sessionId) === worker) {
        captureWorkers.delete(params.sessionId);
      }
    });
  return worker.running;
}

export async function flushCaptureQueue(sessionId?: string): Promise<void> {
  if (sessionId) {
    await captureWorkers.get(sessionId)?.running;
    return;
  }
  await Promise.allSettled([...captureWorkers.values()].map((worker) => worker.running));
}

async function captureDeltaUnsafe(params: CaptureParams): Promise<void> {
  const { sessionId, sessionFile, trigger } = params;

  const auth = await loadAuth();
  if (!auth) {
    log(`skip: auth missing at ${AUTH_PATH}`);
    return;
  }

  let size: number;
  try {
    size = (await stat(sessionFile)).size;
  } catch (err) {
    log(`session file unavailable at ${sessionFile}: ${(err as Error).message}`);
    return;
  }

  const all = await loadAllState();
  const prior = all[sessionId];
  const lastOffset = prior?.last_byte_offset ?? 0;
  if (size <= lastOffset) return; // nothing new

  const full = await readFile(sessionFile);
  const deltaBytes = full.subarray(lastOffset);
  const delta = deltaBytes.toString("utf8");
  if (!delta.trim()) return;

  const assistantTurns = countAssistantTurns(delta);
  if (assistantTurns === 0 && !prior) {
    // First capture and nothing substantive yet — wait for more.
    return;
  }

  const identity = sourceIdentity(auth.machine_id, sessionId, sessionFile);
  const outboxPath = pendingOutboxPath(identity, lastOffset);
  const pending = await pendingBody(outboxPath);
  const runId = typeof pending?.run_id === "string" ? pending.run_id : newRunId();
  const body: Record<string, unknown> = {
    run_id: runId,
    agent_runtime: RUNTIME,
    tags: ["captured", `session:${sessionId}`, `trigger:${trigger}`],
    started_at: typeof pending?.started_at === "number" ? pending.started_at : Date.now(),
    conversation_id: sessionId,
    source_identity: identity,
    from_offset: lastOffset,
    to_offset: size,
    jsonl_sha256: sha256(deltaBytes),
    jsonl: delta,
  };
  if (prior?.last_run_id) body.parent_run_id = prior.last_run_id;

  try {
    if (!(await writeToOutbox(outboxPath, body))) return;
    const res = await fetch(`${CENTRAL_URL}/api/runs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) {
      const errText = await res.text();
      log(
        `POST ${res.status} session=${sessionId}; outboxed run=${runId}: ${errText.slice(0, 160)}`,
      );
      return;
    }
    const resp = (await res.json()) as { run_id?: string; to_offset?: number };
    const acceptedOffset =
      Number.isSafeInteger(resp.to_offset) &&
      (resp.to_offset as number) >= lastOffset &&
      (resp.to_offset as number) <= size
        ? (resp.to_offset as number)
        : size;
    const acceptedTurns = countAssistantTurns(
      deltaBytes.subarray(0, acceptedOffset - lastOffset).toString("utf8"),
    );
    all[sessionId] = {
      last_byte_offset: acceptedOffset,
      last_run_id: resp.run_id ?? runId,
      last_captured_at: new Date().toISOString(),
      turn_count: (prior?.turn_count ?? 0) + acceptedTurns,
    };
    if (!(await commitSessionState(sessionId, all[sessionId]))) return;
    await clearPending(outboxPath);
    log(
      `captured run=${resp.run_id} session=${sessionId} delta=${delta.length}B turns=${assistantTurns} trigger=${trigger}`,
    );
  } catch (err) {
    log(`network error session=${sessionId}; outboxed: ${(err as Error).message}`);
  }
}

export default function memoryCapture(pi: ExtensionAPI) {
  pi.on("turn_end", (_event, ctx) => {
    try {
      const sessionFile = ctx.sessionManager.getSessionFile();
      const sessionId = ctx.sessionManager.getSessionId();
      if (!sessionFile || !sessionId) return;
      void scheduleCapture({ sessionId, sessionFile, trigger: "turn_end" });
    } catch (err) {
      log(`turn_end handler fatal: ${(err as Error).message}`);
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    try {
      const sessionFile = ctx.sessionManager.getSessionFile();
      const sessionId = ctx.sessionManager.getSessionId();
      if (!sessionFile || !sessionId) return;
      void scheduleCapture({
        sessionId,
        sessionFile,
        trigger: "session_shutdown",
      });
    } catch (err) {
      log(`session_shutdown handler fatal: ${(err as Error).message}`);
    }
  });
}
