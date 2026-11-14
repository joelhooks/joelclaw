import type { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import type { Drain } from "./drain";
import { fold, readHealth } from "./outbox";
import type { CapturedPayload } from "./types";

const AGENT_RUNTIMES = new Set([
  "pi",
  "claude-code",
  "codex",
  "cursor",
  "grok",
  "opencode",
  "loop",
  "workload-stage",
  "gateway",
  "other",
]);

const MAX_BODY_BYTES = 64 * 1024;

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalOffset(value: unknown): boolean {
  return value === undefined || (Number.isSafeInteger(value) && (value as number) >= 0);
}

/** Validate a `memory/run.captured` payload; accepts the bare data or the whole event. */
export function parseCapturedPayload(value: unknown): CapturedPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const data = (
    record.name === "memory/run.captured" && record.data && typeof record.data === "object"
      ? record.data
      : record
  ) as Record<string, unknown>;
  if (data.jsonl_inline !== undefined) return null;
  const valid =
    typeof data.run_id === "string" &&
    data.run_id.length > 0 &&
    typeof data.user_id === "string" &&
    typeof data.machine_id === "string" &&
    typeof data.agent_runtime === "string" &&
    AGENT_RUNTIMES.has(data.agent_runtime) &&
    typeof data.jsonl_path === "string" &&
    data.jsonl_path.length > 0 &&
    Number.isSafeInteger(data.jsonl_bytes) &&
    (data.jsonl_bytes as number) >= 0 &&
    typeof data.jsonl_sha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(data.jsonl_sha256) &&
    Number.isSafeInteger(data.started_at) &&
    optionalString(data.parent_run_id) &&
    optionalString(data.conversation_id) &&
    optionalString(data.source_identity) &&
    optionalOffset(data.from_offset) &&
    optionalOffset(data.to_offset) &&
    (data.tags === undefined ||
      (Array.isArray(data.tags) && data.tags.every((tag) => typeof tag === "string")));
  if (!valid) return null;
  const payload: CapturedPayload = {
    run_id: data.run_id as string,
    user_id: data.user_id as string,
    machine_id: data.machine_id as string,
    agent_runtime: data.agent_runtime as CapturedPayload["agent_runtime"],
    jsonl_path: data.jsonl_path as string,
    jsonl_bytes: data.jsonl_bytes as number,
    jsonl_sha256: data.jsonl_sha256 as string,
    started_at: data.started_at as number,
  };
  for (const key of [
    "parent_run_id",
    "conversation_id",
    "tags",
    "from_offset",
    "to_offset",
    "source_identity",
  ] as const) {
    if (data[key] !== undefined) (payload as unknown as Record<string, unknown>)[key] = data[key];
  }
  return payload;
}

function bearerMatches(header: string | null, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice("Bearer ".length).trim());
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export interface CellServerDeps {
  db: Database;
  drain: Drain;
  token: string;
  now: () => number;
  mode?: "shadow" | "cell";
}

/** The cell's HTTP surface, as a fetch handler so tests can call it directly. */
export function createCellHandler(deps: CellServerDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json(readHealth(deps.db, deps.now(), deps.mode));
    }
    if (request.method !== "POST" || url.pathname !== "/capture") {
      return Response.json({ ok: false, error: { code: "not_found" } }, { status: 404 });
    }
    if (!bearerMatches(request.headers.get("authorization"), deps.token)) {
      return Response.json({ ok: false, error: { code: "unauthorized" } }, { status: 401 });
    }
    const text = await request.text();
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) {
      return Response.json({ ok: false, error: { code: "payload_too_large" } }, { status: 413 });
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    const payload = parseCapturedPayload(body);
    if (!payload) {
      return Response.json(
        {
          ok: false,
          error: {
            code: "invalid_capture",
            message: "body must be a memory/run.captured payload with jsonl_path (no jsonl_inline)",
          },
        },
        { status: 400 },
      );
    }
    const requestedMode = request.headers.get("x-capture-cell-mode");
    const writer = requestedMode === "cell" || (requestedMode !== "both" && deps.mode === "cell");
    if (writer && deps.mode !== "cell") {
      return Response.json({ ok: false, error: { code: "writer_not_enabled" } }, { status: 503 });
    }
    let duplicate: boolean;
    try {
      // The single save. 202 only after it commits.
      duplicate =
        fold(deps.db, { type: "captured", payload, at: deps.now(), writer }).facts.length === 0;
    } catch (error) {
      console.error("[capture-cell] save failed", { run_id: payload.run_id, error: String(error) });
      return Response.json({ ok: false, error: { code: "save_failed" } }, { status: 503 });
    }
    deps.drain.kick();
    return Response.json({ ok: true, run_id: payload.run_id, duplicate }, { status: 202 });
  };
}
