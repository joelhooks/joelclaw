#!/usr/bin/env node
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HOME = homedir();
const DEFAULT_DATABASE = path.join(HOME, ".local/share/opencode/opencode.db");
const DEFAULT_AUTH = path.join(HOME, ".joelclaw/auth.json");
const MACHINE_NAME = hostname().replace(/\..*$/u, "").toLowerCase();
const DEFAULT_STATE = path.join(
  HOME,
  ".joelclaw",
  "capture",
  MACHINE_NAME,
  "opencode",
  "state.json",
);
const DEFAULT_CENTRAL = "http://127.0.0.1:3111";
const MAX_SESSIONS = 1_000;
const HTTP_TIMEOUT_MS = 10_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const hashIdentity = (...parts) => `sha256:${sha256(JSON.stringify(parts))}`;
const canonicalLine = (value) => `${JSON.stringify(value)}\n`;
const object = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

function safeInteger(value, field) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`opencode-invalid-${field}`);
  }
  return value;
}

function parseObjectJson(value, code) {
  try {
    const parsed = JSON.parse(value);
    if (!object(parsed)) throw new Error(code);
    return parsed;
  } catch {
    throw new Error(code);
  }
}

function requireColumns(database, table, required) {
  const rows = database.prepare(`PRAGMA table_info("${table}")`).all();
  const actual = new Set(rows.map((row) => row.name));
  if (required.some((name) => !actual.has(name))) {
    throw new Error("opencode-source-schema-mismatch");
  }
}

function indexableParts(parts) {
  const content = [];
  for (const part of parts) {
    const value = parseObjectJson(part.data, "opencode-part-invalid");
    if (value.type === "text" && typeof value.text === "string") {
      content.push({ type: "text", text: value.text });
      continue;
    }
    if (value.type === "reasoning" && typeof value.text === "string") {
      content.push({ type: "thinking", thinking: value.text });
      continue;
    }
    if (value.type === "tool") {
      const state = object(value.state) ? value.state : {};
      const input = state.input ?? value.input ?? {};
      content.push({
        type: "tool_use",
        name: typeof value.tool === "string" ? value.tool : "unknown",
        input,
      });
      const output = state.output ?? value.output;
      if (output !== undefined && output !== null && output !== "") {
        content.push({ type: "tool_result", content: output });
      }
    }
  }
  return content;
}

function buildSessionSnapshot(session, messages, partsByMessage) {
  const records = [
    canonicalLine({
      type: "opencode_session",
      session_id: session.id,
      parent_session_id: session.parent_id ?? null,
      timestamp: new Date(safeInteger(session.time_created, "session-time")).toISOString(),
      version: session.version,
    }),
  ];

  for (const message of messages) {
    const messageData = parseObjectJson(message.data, "opencode-message-invalid");
    const parts = partsByMessage.get(message.id) ?? [];
    const role = messageData.role === "user" ? "user" : "assistant";
    const createdAt = safeInteger(message.time_created, "message-time");
    records.push(
      canonicalLine({
        type: role,
        timestamp: new Date(createdAt).toISOString(),
        message: { role, content: indexableParts(parts) },
        opencode_raw: {
          message_id: message.id,
          message_json: message.data,
          parts: parts.map((part) => ({ id: part.id, data: part.data })),
        },
      }),
    );
  }

  return Buffer.from(records.join(""), "utf8");
}

export function readOpenCodeSnapshots(databasePath = DEFAULT_DATABASE, maxSessions = MAX_SESSIONS) {
  if (!Number.isSafeInteger(maxSessions) || maxSessions < 1) {
    throw new Error("invalid-max-sessions");
  }
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout = 2500");
    database.exec("PRAGMA query_only = ON");
    const version = database.prepare("PRAGMA user_version").get().user_version;
    if (version !== 0) throw new Error("opencode-source-unsupported-version");
    requireColumns(database, "session", [
      "id",
      "parent_id",
      "version",
      "time_created",
      "time_updated",
    ]);
    requireColumns(database, "message", [
      "id",
      "session_id",
      "time_created",
      "time_updated",
      "data",
    ]);
    requireColumns(database, "part", [
      "id",
      "message_id",
      "session_id",
      "time_created",
      "time_updated",
      "data",
    ]);

    database.exec("BEGIN");
    const sessions = database
      .prepare(
        "SELECT id, parent_id, version, time_created, time_updated FROM session ORDER BY time_created, id LIMIT ?",
      )
      .all(maxSessions);
    const readMessages = database.prepare(
      "SELECT id, time_created, time_updated, data FROM message WHERE session_id = ? ORDER BY time_created, id",
    );
    const readParts = database.prepare(
      "SELECT id, message_id, time_created, time_updated, data FROM part WHERE session_id = ? ORDER BY time_created, id",
    );
    const snapshots = [];

    for (const session of sessions) {
      const messages = readMessages.all(session.id);
      if (messages.length === 0) continue;
      const partsByMessage = new Map();
      for (const part of readParts.all(session.id)) {
        const group = partsByMessage.get(part.message_id) ?? [];
        group.push(part);
        partsByMessage.set(part.message_id, group);
      }
      const bytes = buildSessionSnapshot(session, messages, partsByMessage);
      snapshots.push({
        sessionId: session.id,
        parentSessionId: session.parent_id ?? undefined,
        startedAt: safeInteger(session.time_created, "session-time"),
        updatedAt: safeInteger(session.time_updated, "session-time"),
        bytes,
        sha256: sha256(bytes),
      });
    }
    database.exec("COMMIT");
    return snapshots;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // No transaction was opened or SQLite already rolled it back.
    }
    throw error;
  } finally {
    database.close();
  }
}

function validState(state) {
  return (
    object(state) &&
    state.version === 1 &&
    object(state.entries) &&
    Object.values(state.entries).every(
      (entry) =>
        object(entry) &&
        typeof entry.source_identity === "string" &&
        Number.isSafeInteger(entry.last_byte_offset) &&
        entry.last_byte_offset >= 0 &&
        typeof entry.prefix_sha256 === "string" &&
        /^[0-9a-f]{64}$/u.test(entry.prefix_sha256),
    )
  );
}

export function planSessionCapture(snapshot, prior, machineId) {
  const currentBytes = snapshot.bytes;
  if (!Buffer.isBuffer(currentBytes) || currentBytes.byteLength === 0) {
    return { _tag: "unchanged" };
  }
  if (prior === undefined) {
    return {
      _tag: "capture",
      fromOffset: 0,
      sourceIdentity: hashIdentity("opencode-native-run:v1", machineId, snapshot.sessionId),
      rebased: false,
    };
  }
  if (prior.last_byte_offset > currentBytes.byteLength) {
    return {
      _tag: "capture",
      fromOffset: 0,
      sourceIdentity: hashIdentity(
        "opencode-native-rebase:v1",
        machineId,
        snapshot.sessionId,
        snapshot.sha256,
      ),
      rebased: true,
    };
  }
  const prefix = currentBytes.subarray(0, prior.last_byte_offset);
  if (sha256(prefix) !== prior.prefix_sha256) {
    return {
      _tag: "capture",
      fromOffset: 0,
      sourceIdentity: hashIdentity(
        "opencode-native-rebase:v1",
        machineId,
        snapshot.sessionId,
        snapshot.sha256,
      ),
      rebased: true,
    };
  }
  if (prior.last_byte_offset === currentBytes.byteLength) return { _tag: "unchanged" };
  return {
    _tag: "capture",
    fromOffset: prior.last_byte_offset,
    sourceIdentity: prior.source_identity,
    rebased: false,
  };
}

async function readAuth(authPath) {
  let value;
  try {
    value = JSON.parse(await readFile(authPath, "utf8"));
  } catch {
    throw new Error("capture-auth-unavailable");
  }
  if (
    !object(value) ||
    typeof value.machine_id !== "string" ||
    value.machine_id.length === 0 ||
    typeof value.user_id !== "string" ||
    value.user_id.length === 0 ||
    typeof value.token !== "string" ||
    value.token.length === 0
  ) {
    throw new Error("capture-auth-invalid");
  }
  return { machineId: value.machine_id, userId: value.user_id, token: value.token };
}

async function loadState(statePath) {
  let value;
  try {
    value = JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, entries: {} };
    throw new Error("opencode-capture-state-invalid");
  }
  if (!validState(value)) throw new Error("opencode-capture-state-invalid");
  return value;
}

async function writeStateAtomic(statePath, state) {
  await mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const temporary = `${statePath}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, statePath);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function runIdFor(machineId, sourceIdentity, fromOffset, digest) {
  return sha256(
    JSON.stringify(["opencode-run:v1", machineId, sourceIdentity, fromOffset, digest]),
  ).slice(0, 26);
}

async function postSegment(snapshot, plan, auth, options) {
  const bodyBytes = snapshot.bytes.subarray(plan.fromOffset);
  if (bodyBytes.byteLength === 0 || bodyBytes.at(-1) !== 0x0a) {
    throw new Error("opencode-segment-not-line-aligned");
  }
  const digest = sha256(bodyBytes);
  const runId = runIdFor(auth.machineId, plan.sourceIdentity, plan.fromOffset, digest);
  const body = {
    run_id: runId,
    agent_runtime: "opencode",
    started_at: snapshot.startedAt,
    parent_run_id: plan.priorRunId,
    conversation_id: snapshot.sessionId,
    source_session_id: snapshot.sessionId,
    event_id: `opencode:${sha256(JSON.stringify([plan.sourceIdentity, plan.fromOffset, digest])).slice(0, 40)}`,
    tags: [
      "captured",
      "backfill",
      "runtime:opencode",
      "source:opencode-native-sqlite",
      `machine:${auth.machineId}`,
    ],
    source_identity: plan.sourceIdentity,
    from_offset: plan.fromOffset,
    to_offset: plan.fromOffset + bodyBytes.byteLength,
    jsonl_sha256: digest,
    jsonl: decoder.decode(bodyBytes),
  };
  const idempotencyKey = `sha256:${sha256(JSON.stringify([auth.machineId, "opencode", plan.sourceIdentity, plan.fromOffset, digest]))}`;
  let response;
  try {
    response = await options.fetch(`${options.centralUrl}/api/runs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch {
    throw new Error("capture-network-failed");
  }
  let receipt;
  try {
    receipt = await response.json();
  } catch {
    throw new Error("capture-response-invalid");
  }
  if (!response.ok || !object(receipt) || typeof receipt.run_id !== "string") {
    throw new Error(`capture-http-${response.status}`);
  }
  const toOffset = safeInteger(receipt.to_offset, "accepted-offset");
  if (toOffset <= plan.fromOffset || toOffset > snapshot.bytes.byteLength) {
    throw new Error("capture-offset-invalid");
  }
  if (snapshot.bytes[toOffset - 1] !== 0x0a) throw new Error("capture-offset-not-line-aligned");
  return {
    runId: receipt.run_id,
    status: receipt.status === "accepted_prefix" ? "duplicate" : "accepted",
    toOffset,
  };
}

export async function captureSnapshots(snapshots, options) {
  const state = await loadState(options.statePath);
  const results = {
    accepted: 0,
    duplicate: 0,
    failed: 0,
    failure_codes: {},
    rebased: 0,
    unchanged: 0,
  };
  for (const snapshot of snapshots) {
    const key = snapshot.sessionId;
    let prior = state.entries[key];
    let plan = planSessionCapture(snapshot, prior, options.auth.machineId);
    if (plan._tag === "unchanged") {
      results.unchanged += 1;
      continue;
    }
    if (plan.rebased) results.rebased += 1;
    let iterations = 0;
    while (plan.fromOffset < snapshot.bytes.byteLength) {
      if (++iterations > MAX_SESSIONS) {
        results.failed += 1;
        results.failure_codes["capture-prefix-limit"] =
          (results.failure_codes["capture-prefix-limit"] ?? 0) + 1;
        break;
      }
      try {
        const receipt = await postSegment(
          snapshot,
          { ...plan, priorRunId: prior?.last_run_id },
          options.auth,
          options,
        );
        if (receipt.status === "duplicate") results.duplicate += 1;
        else results.accepted += 1;
        const prefix = snapshot.bytes.subarray(0, receipt.toOffset);
        prior = {
          source_identity: plan.sourceIdentity,
          last_byte_offset: receipt.toOffset,
          prefix_sha256: sha256(prefix),
          last_run_id: receipt.runId,
        };
        state.entries[key] = prior;
        await writeStateAtomic(options.statePath, state);
        if (receipt.toOffset === snapshot.bytes.byteLength) break;
        plan = {
          _tag: "capture",
          fromOffset: receipt.toOffset,
          sourceIdentity: plan.sourceIdentity,
          rebased: false,
        };
      } catch (error) {
        results.failed += 1;
        const code =
          error instanceof Error && /^[a-z0-9-]+$/u.test(error.message)
            ? error.message
            : "capture-failed";
        results.failure_codes[code] = (results.failure_codes[code] ?? 0) + 1;
        break;
      }
    }
  }
  return results;
}

function parseArgs(argv) {
  const args = { apply: false, maxSessions: MAX_SESSIONS, summaryOnly: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--dry-run") args.apply = false;
    else if (arg === "--max-sessions") {
      const value = Number(argv[++index]);
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("invalid-max-sessions");
      args.maxSessions = value;
    } else if (arg === "--database") args.databasePath = path.resolve(argv[++index]);
    else if (arg === "--state") args.statePath = path.resolve(argv[++index]);
    else if (arg === "--auth") args.authPath = path.resolve(argv[++index]);
    else if (arg === "--central-url") args.centralUrl = argv[++index];
    else if (arg === "--summary-only") args.summaryOnly = true;
    else throw new Error("unknown-argument");
  }
  return args;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const databasePath = args.databasePath ?? process.env.OPENCODE_DATABASE_PATH ?? DEFAULT_DATABASE;
  const statePath = args.statePath ?? process.env.OPENCODE_RAW_CAPTURE_STATE ?? DEFAULT_STATE;
  const centralUrl = (
    args.centralUrl ??
    process.env.JOELCLAW_SESSION_CAPTURE_URL ??
    process.env.JOELCLAW_CENTRAL_URL ??
    DEFAULT_CENTRAL
  ).replace(/\/$/u, "");
  const snapshots = readOpenCodeSnapshots(databasePath, args.maxSessions);
  const bytes = snapshots.reduce((total, snapshot) => total + snapshot.bytes.byteLength, 0);
  if (!args.apply) {
    console.log(
      JSON.stringify({
        ok: true,
        mode: "dry-run",
        runtime: "opencode",
        discovered: snapshots.length,
        jsonl_bytes: bytes,
      }),
    );
    return;
  }
  const auth = await readAuth(args.authPath ?? process.env.JOELCLAW_AUTH_PATH ?? DEFAULT_AUTH);
  const result = await captureSnapshots(snapshots, {
    auth,
    centralUrl,
    fetch: globalThis.fetch,
    statePath,
  });
  console.log(
    JSON.stringify({
      ok: result.failed === 0,
      mode: "apply",
      runtime: "opencode",
      machine: auth.machineId,
      host: hostname().replace(/\..*$/u, ""),
      discovered: snapshots.length,
      jsonl_bytes: bytes,
      ...result,
    }),
  );
  if (result.failed > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    const code =
      error instanceof Error && /^[a-z0-9-]+$/u.test(error.message)
        ? error.message
        : "capture-failed";
    console.error(JSON.stringify({ ok: false, runtime: "opencode", error: code }));
    process.exitCode = 1;
  });
}
