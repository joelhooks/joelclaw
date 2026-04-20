#!/usr/bin/env bun
/**
 * Claude Code Stop-hook entry point — ADR-0243 Rules 3 + 8.
 *
 * Rule 3: one Run per invocation. In claude-code that = one user→assistant
 * turn. This script fires on every Stop event and captures only the NEW
 * turn(s) since the last capture, tracking per-session byte offsets in
 * ~/.joelclaw/session-state.json.
 *
 * Hook protocol (Claude Code Stop hook, stdin JSON):
 *   {
 *     "session_id": "uuid",
 *     "transcript_path": "/path/to/<uuid>.jsonl",
 *     "stop_hook_active": bool
 *   }
 *
 * Behavior guarantees:
 *   - ALWAYS exits 0. Never blocks Claude Code's continuation.
 *   - On network/Central failure: jsonl gets outboxed, state is NOT advanced,
 *     so next Stop picks up the same delta (idempotent retry).
 *   - On success: state advances to current EOF; Claude can continue.
 *   - Noop (nothing new since last capture) is a silent exit 0.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

interface HookContext {
  session_id?: string;
  transcript_path?: string;
  stop_hook_active?: boolean;
}

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

const CENTRAL_URL = process.env.JOELCLAW_CENTRAL_URL ?? "http://localhost:3000";
const AUTH_PATH =
  process.env.JOELCLAW_AUTH_PATH ?? join(homedir(), ".joelclaw", "auth.json");
const STATE_PATH = join(homedir(), ".joelclaw", "session-state.json");
const OUTBOX_DIR = join(homedir(), ".joelclaw", "outbox");
const LOG_PATH = join(homedir(), ".joelclaw", "capture.log");
const RUNTIME = process.env.JOELCLAW_RUNTIME ?? "claude-code";

function log(message: string) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    const existing = existsSync(LOG_PATH) ? readFileSync(LOG_PATH, "utf8") : "";
    writeFileSync(LOG_PATH, existing + line);
  } catch {
    // can't log; don't crash
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
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

async function readHookContext(): Promise<HookContext> {
  const fileArgIdx = process.argv.indexOf("--file");
  if (fileArgIdx >= 0) {
    const path = process.argv[fileArgIdx + 1];
    if (!path) throw new Error("--file requires a path");
    return JSON.parse(readFileSync(path, "utf8")) as HookContext;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(Buffer.from(chunk as unknown as Uint8Array));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw) as HookContext;
}

function writeToOutbox(runId: string, body: unknown): string {
  mkdirSync(OUTBOX_DIR, { recursive: true });
  const outboxPath = join(OUTBOX_DIR, `${runId}.json`);
  writeFileSync(outboxPath, JSON.stringify(body));
  return outboxPath;
}

function newRunId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 26);
}

function countTurns(jsonlDelta: string): number {
  // Quick heuristic — count assistant messages in the delta.
  let turns = 0;
  for (const line of jsonlDelta.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as {
        type?: string;
        message?: { role?: string };
      };
      if (entry.type === "assistant" && entry.message?.role === "assistant") {
        turns += 1;
      }
    } catch {
      // tolerate malformed lines
    }
  }
  return turns;
}

async function main() {
  let ctx: HookContext;
  try {
    ctx = await readHookContext();
  } catch (err) {
    log(`hook context read failed: ${(err as Error).message}`);
    process.exit(0); // never block
  }

  const sessionId = ctx.session_id;
  const transcriptPath = ctx.transcript_path;

  if (!sessionId || !transcriptPath) {
    log(`no session_id/transcript_path in hook context — skipping`);
    process.exit(0);
  }
  if (!existsSync(transcriptPath)) {
    log(`transcript missing at ${transcriptPath} — skipping`);
    process.exit(0);
  }

  const auth = loadAuth();
  if (!auth) {
    log(`auth missing/invalid at ${AUTH_PATH} — skipping`);
    process.exit(0);
  }

  let currentSize: number;
  try {
    currentSize = statSync(transcriptPath).size;
  } catch (err) {
    log(`cannot stat transcript: ${(err as Error).message}`);
    process.exit(0);
  }

  const allState = loadAllState();
  const prior = allState[sessionId];
  const lastOffset = prior?.last_byte_offset ?? 0;

  if (currentSize <= lastOffset) {
    // Nothing new since last capture (or transcript shrunk — either way skip).
    process.exit(0);
  }

  // Read only the delta. Bun.file().slice() would be ideal but .text() reads
  // the whole file; for now accept the O(n) read and slice in memory.
  const fullText = readFileSync(transcriptPath, "utf8");
  const delta = fullText.slice(lastOffset);
  if (!delta.trim()) {
    process.exit(0);
  }

  const turnCount = countTurns(delta);
  if (turnCount === 0 && !prior) {
    // First capture of a session that has no assistant turns yet — skip,
    // we'll come back on a later Stop when there's something to embed.
    process.exit(0);
  }

  const runId = newRunId();
  const body: Record<string, unknown> = {
    run_id: runId,
    agent_runtime: RUNTIME,
    tags: [
      "captured",
      `basename:${basename(transcriptPath)}`,
      `session:${sessionId}`,
    ],
    started_at: Date.now(),
    conversation_id: sessionId,
    jsonl: delta,
  };
  if (prior?.last_run_id) {
    body.parent_run_id = prior.last_run_id;
  }

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
      const outbox = writeToOutbox(runId, body);
      log(
        `POST failed ${res.status} for session=${sessionId}; outboxed to ${outbox}: ${errText.slice(0, 200)}`
      );
      process.exit(0); // outbox drained later; don't block
    }
    const resp = (await res.json()) as { run_id?: string };
    allState[sessionId] = {
      last_byte_offset: currentSize,
      last_run_id: resp.run_id ?? runId,
      last_captured_at: new Date().toISOString(),
      turn_count: (prior?.turn_count ?? 0) + turnCount,
    };
    saveAllState(allState);
    log(
      `captured run_id=${resp.run_id} session=${sessionId} delta_bytes=${delta.length} turns=${turnCount}`
    );
    process.exit(0);
  } catch (err) {
    const outbox = writeToOutbox(runId, body);
    log(
      `network error for session=${sessionId}; outboxed to ${outbox}: ${(err as Error).message}`
    );
    process.exit(0);
  }
}

main().catch((err) => {
  log(`fatal: ${(err as Error).message}`);
  process.exit(0); // NEVER block Claude Code
});
