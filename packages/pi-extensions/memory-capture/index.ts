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
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const CENTRAL_URL = process.env.JOELCLAW_CENTRAL_URL ?? "http://localhost:3000";
const AUTH_PATH =
  process.env.JOELCLAW_AUTH_PATH ?? join(homedir(), ".joelclaw", "auth.json");
const STATE_PATH = join(homedir(), ".joelclaw", "session-state.json");
const OUTBOX_DIR = join(homedir(), ".joelclaw", "outbox");
const LOG_PATH = join(homedir(), ".joelclaw", "capture.log");
const RUNTIME = "pi";

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

function log(message: string) {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    const line = `[${new Date().toISOString()}] [pi] ${message}\n`;
    const existing = existsSync(LOG_PATH) ? readFileSync(LOG_PATH, "utf8") : "";
    writeFileSync(LOG_PATH, existing + line);
  } catch {
    // swallow; never break pi
  }
}

function loadAuth(): AuthFile | null {
  try {
    if (!existsSync(AUTH_PATH)) return null;
    const auth = JSON.parse(readFileSync(AUTH_PATH, "utf8")) as AuthFile;
    if (!auth.token || !auth.user_id || !auth.machine_id) return null;
    return auth;
  } catch {
    return null;
  }
}
function loadAllState(): Record<string, SessionState> {
  try {
    if (!existsSync(STATE_PATH)) return {};
    return JSON.parse(readFileSync(STATE_PATH, "utf8")) as Record<
      string,
      SessionState
    >;
  } catch {
    return {};
  }
}
function saveAllState(state: Record<string, SessionState>) {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (err) {
    log(`save state failed: ${(err as Error).message}`);
  }
}
function writeToOutbox(runId: string, body: unknown): string {
  try {
    mkdirSync(OUTBOX_DIR, { recursive: true });
    const outboxPath = join(OUTBOX_DIR, `${runId}.json`);
    writeFileSync(outboxPath, JSON.stringify(body));
    return outboxPath;
  } catch (err) {
    log(`outbox write failed: ${(err as Error).message}`);
    return "";
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

async function captureDelta(params: {
  sessionId: string;
  sessionFile: string;
  trigger: "turn_end" | "session_shutdown";
}): Promise<void> {
  const { sessionId, sessionFile, trigger } = params;

  const auth = loadAuth();
  if (!auth) {
    log(`skip: auth missing at ${AUTH_PATH}`);
    return;
  }
  if (!existsSync(sessionFile)) {
    log(`skip: session file missing at ${sessionFile}`);
    return;
  }

  let size: number;
  try {
    size = statSync(sessionFile).size;
  } catch (err) {
    log(`stat failed: ${(err as Error).message}`);
    return;
  }

  const all = loadAllState();
  const prior = all[sessionId];
  const lastOffset = prior?.last_byte_offset ?? 0;
  if (size <= lastOffset) return; // nothing new

  const full = readFileSync(sessionFile, "utf8");
  const delta = full.slice(lastOffset);
  if (!delta.trim()) return;

  const assistantTurns = countAssistantTurns(delta);
  if (assistantTurns === 0 && !prior) {
    // First capture and nothing substantive yet — wait for more.
    return;
  }

  const runId = newRunId();
  const body: Record<string, unknown> = {
    run_id: runId,
    agent_runtime: RUNTIME,
    tags: ["captured", `session:${sessionId}`, `trigger:${trigger}`],
    started_at: Date.now(),
    conversation_id: sessionId,
    jsonl: delta,
  };
  if (prior?.last_run_id) body.parent_run_id = prior.last_run_id;

  try {
    const res = await fetch(`${CENTRAL_URL}/api/runs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text();
      writeToOutbox(runId, body);
      log(
        `POST ${res.status} session=${sessionId}; outboxed run=${runId}: ${errText.slice(0, 160)}`
      );
      return;
    }
    const resp = (await res.json()) as { run_id?: string };
    all[sessionId] = {
      last_byte_offset: size,
      last_run_id: resp.run_id ?? runId,
      last_captured_at: new Date().toISOString(),
      turn_count: (prior?.turn_count ?? 0) + assistantTurns,
    };
    saveAllState(all);
    log(
      `captured run=${resp.run_id} session=${sessionId} delta=${delta.length}B turns=${assistantTurns} trigger=${trigger}`
    );
  } catch (err) {
    writeToOutbox(runId, body);
    log(`network error session=${sessionId}; outboxed: ${(err as Error).message}`);
  }
}

export default function memoryCapture(pi: ExtensionAPI) {
  pi.on("turn_end", async (_event, ctx) => {
    try {
      const sessionFile = ctx.sessionManager.getSessionFile();
      const sessionId = ctx.sessionManager.getSessionId();
      if (!sessionFile || !sessionId) return;
      await captureDelta({ sessionId, sessionFile, trigger: "turn_end" });
    } catch (err) {
      log(`turn_end handler fatal: ${(err as Error).message}`);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      const sessionFile = ctx.sessionManager.getSessionFile();
      const sessionId = ctx.sessionManager.getSessionId();
      if (!sessionFile || !sessionId) return;
      await captureDelta({
        sessionId,
        sessionFile,
        trigger: "session_shutdown",
      });
    } catch (err) {
      log(`session_shutdown handler fatal: ${(err as Error).message}`);
    }
  });
}
