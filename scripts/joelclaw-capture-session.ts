#!/usr/bin/env bun
/**
 * Claude Code Stop-hook entry point — ADR-0243 Rule 8.
 *
 * Invoked by claude-code when a session ends. Stdin carries the hook context
 * as JSON (Claude Code hook protocol):
 *   {
 *     "session_id": "uuid",
 *     "transcript_path": "/Users/.../<uuid>.jsonl",
 *     "stop_hook_active": bool
 *   }
 *
 * Behavior:
 *   1. Read hook JSON from stdin (or --file for manual testing)
 *   2. Read the transcript jsonl from transcript_path
 *   3. Load bearer + identity from ~/.joelclaw/auth.json
 *   4. POST to the Central ingest endpoint (TAILNET-only in prod)
 *   5. On failure, write the jsonl to ~/.joelclaw/outbox/ for later drain
 *
 * Exit codes:
 *   0  success — Run accepted by Central
 *   0  skipped — nothing substantive to capture (claude-code reuses Stop
 *      hooks on empty sessions; we don't want noisy exits)
 *   1  hard failure — malformed input, can't read transcript, etc.
 *   2  network failure — wrote to Outbox, not a fatal error
 *
 * Claude Code will log stdout/stderr to its hook log; keep output tight.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
  issued_at?: string;
}

const CENTRAL_URL = process.env.JOELCLAW_CENTRAL_URL ?? "http://localhost:3000";
const AUTH_PATH = process.env.JOELCLAW_AUTH_PATH ?? join(homedir(), ".joelclaw", "auth.json");
const OUTBOX_DIR = join(homedir(), ".joelclaw", "outbox");
const RUNTIME = process.env.JOELCLAW_RUNTIME ?? "claude-code";

function log(message: string) {
  console.error(`[joelclaw-capture] ${message}`);
}

function loadAuth(): AuthFile {
  if (!existsSync(AUTH_PATH)) {
    throw new Error(`auth missing: ${AUTH_PATH}`);
  }
  const raw = readFileSync(AUTH_PATH, "utf8");
  const auth = JSON.parse(raw) as AuthFile;
  if (!auth.token || !auth.user_id || !auth.machine_id) {
    throw new Error(`auth.json malformed — need user_id, machine_id, token`);
  }
  return auth;
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
  if (!raw) {
    // Sometimes claude-code invokes the hook with no body (e.g. session
    // reused). Fall back to the most-recent session jsonl in the project dir.
    return {};
  }
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

async function main() {
  const ctx = await readHookContext();
  const transcriptPath = ctx.transcript_path;
  if (!transcriptPath || !existsSync(transcriptPath)) {
    log(`no usable transcript_path (got: ${transcriptPath ?? "<none>"}) — skipping`);
    process.exit(0);
  }

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(transcriptPath);
  } catch (err) {
    log(`cannot stat transcript: ${(err as Error).message}`);
    process.exit(1);
  }

  if (stat.size === 0) {
    log(`empty transcript at ${transcriptPath} — skipping`);
    process.exit(0);
  }

  const jsonl = readFileSync(transcriptPath, "utf8");
  const auth = loadAuth();
  const runId = newRunId();

  const body: Record<string, unknown> = {
    run_id: runId,
    agent_runtime: RUNTIME,
    tags: ["captured", `basename:${basename(transcriptPath)}`, `dir:${basename(dirname(transcriptPath))}`],
    started_at: stat.birthtimeMs || stat.mtimeMs,
    conversation_id: ctx.session_id ?? basename(transcriptPath, ".jsonl"),
    jsonl,
  };

  const parentRunId = process.env.JOELCLAW_PARENT_RUN_ID;
  if (parentRunId) body.parent_run_id = parentRunId;

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
      log(`POST failed ${res.status}; outboxed to ${outbox}: ${errText.slice(0, 200)}`);
      process.exit(2);
    }
    const resp = (await res.json()) as { run_id?: string };
    log(`captured run_id=${resp.run_id} from ${basename(transcriptPath)} (${stat.size} bytes)`);
    process.exit(0);
  } catch (err) {
    const outbox = writeToOutbox(runId, body);
    log(`network error; outboxed to ${outbox}: ${(err as Error).message}`);
    process.exit(2);
  }
}

main().catch((err) => {
  log(`fatal: ${(err as Error).message}`);
  process.exit(1);
});
