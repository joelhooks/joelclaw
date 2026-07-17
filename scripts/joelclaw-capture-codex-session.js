#!/usr/bin/env node
/**
 * Codex Stop-hook entry point — ADR-0243 Runs-Based Memory Capture.
 *
 * Captures the newly-written Codex transcript delta for each Stop event and
 * POSTs it to Central /api/runs with agent_runtime="codex". Mirrors the Pi
 * memory-capture extension and Claude Code hook, but uses plain Node so it can
 * run on thin joelclaw machines without Bun.
 *
 * Codex hook stdin includes session_id, transcript_path, cwd, hook_event_name,
 * model, turn_id, stop_hook_active, and last_assistant_message. Hook schema is
 * intentionally treated as soft: missing transcript/session means noop.
 *
 * Guarantees:
 * - exits 0 and emits valid JSON so Codex continues
 * - never prints secrets
 * - outboxes failed POST bodies to ~/.joelclaw/outbox/
 * - advances byte-offset state only after Central accepts the run
 */
const { randomUUID } = require("node:crypto");
const {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} = require("node:fs");
const { homedir, hostname } = require("node:os");
const { basename, dirname, join } = require("node:path");

const CENTRAL_URL = process.env.JOELCLAW_CENTRAL_URL || "http://127.0.0.1:3111";
const AUTH_PATH = process.env.JOELCLAW_AUTH_PATH || join(homedir(), ".joelclaw", "auth.json");
const STATE_PATH = join(homedir(), ".joelclaw", "codex-session-state.json");
const OUTBOX_DIR = join(homedir(), ".joelclaw", "outbox");
const LOG_PATH = join(homedir(), ".joelclaw", "codex-capture.log");
const RUNTIME = "codex";

function respond(extra = {}) {
  process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true, ...extra }));
}

function log(message) {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${message}\n`, { mode: 0o600 });
  } catch {
    // Never break Codex over logging.
  }
}

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function loadJson(path, fallback) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function loadAuth() {
  const auth = loadJson(AUTH_PATH, null);
  if (!auth || !auth.token || !auth.user_id || !auth.machine_id) return null;
  return auth;
}

function newRunId() {
  return randomUUID().replace(/-/g, "").slice(0, 26);
}

function writeToOutbox(runId, body) {
  mkdirSync(OUTBOX_DIR, { recursive: true });
  const outboxPath = join(OUTBOX_DIR, `${runId}.json`);
  writeFileSync(outboxPath, JSON.stringify(body));
  return outboxPath;
}

function countSubstantiveLines(jsonlDelta) {
  return jsonlDelta.split("\n").filter((line) => line.trim()).length;
}

function stateKey(ctx) {
  const sessionId = String(ctx.session_id || "unknown-session");
  const transcriptPath = String(ctx.transcript_path || "unknown-transcript");
  return `${sessionId}:${transcriptPath}`;
}

async function main() {
  let ctx;
  try {
    ctx = await readStdinJson();
  } catch (err) {
    log(`stdin parse failed: ${err.message}`);
    respond();
    return;
  }

  const sessionId = typeof ctx.session_id === "string" ? ctx.session_id : undefined;
  const transcriptPath = typeof ctx.transcript_path === "string" ? ctx.transcript_path : undefined;
  if (!sessionId || !transcriptPath) {
    log("skip: missing session_id/transcript_path");
    respond();
    return;
  }
  if (!existsSync(transcriptPath)) {
    log(`skip: transcript missing at ${transcriptPath}`);
    respond();
    return;
  }

  const auth = loadAuth();
  if (!auth) {
    log(`skip: auth missing/invalid at ${AUTH_PATH}`);
    respond();
    return;
  }

  let currentSize;
  try {
    currentSize = statSync(transcriptPath).size;
  } catch (err) {
    log(`stat failed: ${err.message}`);
    respond();
    return;
  }

  const allState = loadJson(STATE_PATH, {});
  const key = stateKey(ctx);
  const prior = allState[key];
  const lastOffset = typeof prior?.last_byte_offset === "number" ? prior.last_byte_offset : 0;
  if (currentSize <= lastOffset) {
    respond();
    return;
  }

  let delta;
  try {
    const full = readFileSync(transcriptPath, "utf8");
    delta = full.slice(lastOffset);
  } catch (err) {
    log(`read failed: ${err.message}`);
    respond();
    return;
  }

  if (!delta.trim()) {
    respond();
    return;
  }

  const lineCount = countSubstantiveLines(delta);
  const runId = newRunId();
  const body = {
    run_id: runId,
    agent_runtime: RUNTIME,
    tags: [
      "captured",
      "runtime:codex",
      `machine:${auth.machine_id}`,
      `host:${hostname()}`,
      `basename:${basename(transcriptPath)}`,
      `session:${sessionId}`,
    ],
    started_at: Date.now(),
    conversation_id: sessionId,
    jsonl: delta,
  };
  if (ctx.cwd) body.cwd = String(ctx.cwd);
  if (ctx.model) body.model = String(ctx.model);
  if (ctx.turn_id) body.turn_id = String(ctx.turn_id);
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
      const text = await res.text();
      const outbox = writeToOutbox(runId, body);
      log(
        `POST failed status=${res.status} session=${sessionId}; outboxed=${outbox}; ${text.slice(0, 200)}`,
      );
      respond();
      return;
    }

    const payload = await res.json().catch(() => ({}));
    const acceptedRunId = payload.run_id || runId;
    allState[key] = {
      last_byte_offset: currentSize,
      last_run_id: acceptedRunId,
      last_captured_at: new Date().toISOString(),
      line_count: (prior?.line_count || 0) + lineCount,
      transcript_path: transcriptPath,
      session_id: sessionId,
    };
    saveJson(STATE_PATH, allState);
    log(
      `captured run=${acceptedRunId} session=${sessionId} delta=${delta.length}B lines=${lineCount}`,
    );
    respond();
  } catch (err) {
    const outbox = writeToOutbox(runId, body);
    log(`network error session=${sessionId}; outboxed=${outbox}; ${err.message}`);
    respond();
  }
}

main().catch((err) => {
  log(`fatal: ${err.message}`);
  respond();
});
