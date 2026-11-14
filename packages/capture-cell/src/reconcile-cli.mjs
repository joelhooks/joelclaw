#!/usr/bin/env node
import { execFile } from "node:child_process";
import { existsSync, statSync, realpathSync } from "node:fs";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import {
  assertSeparateReconcilePaths,
  DEFAULT_WAIT_ALARM_MS,
  flushReconcileAlarms,
  openReconcileSource,
  openReconcileState,
  reconcileCaptures,
} from "./reconcile.mjs";

import { ReconcileFailure, reconcileFailure, logReconcileFailure } from "./reconcile-error.mjs";

const TIMEOUT = 15_000;
const USAGE = `capture-reconcile [--dry-run|--apply] [--limit N] [--load-limit N]
Node >=22.16 and psql required. Default: read-only dry run. No implicit paths/endpoints.
Required env: CAPTURE_CELL_DB, SESSION_INDEX_PATH, CAPTURE_RECONCILE_DB,
  INNGEST_POSTGRES_URI, INNGEST_CAPTURE_FUNCTION_ID
Apply also requires: INNGEST_BASE_URL, INNGEST_EVENT_KEY, OTEL_EMIT_URL
Optional: OTEL_EMIT_TOKEN, SLOG_SYSTEM_ID, CAPTURE_RECONCILE_LOOKBACK_DAYS (default 2),
  RECONCILE_WAIT_ALARM_MS (default 7200000, two hours from first seen).
Load >40 skips the pass; default resend ceiling 20. See README before scheduling.`;

function required(env, key) {
  if (!env[key]?.trim()) throw new Error("missing_configuration");
  return env[key];
}

function integer(value, max) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max)
    throw new Error("invalid_configuration");
  return number;
}

export function reconcilePostgresEnv(env) {
  const uri = new URL(required(env, "INNGEST_POSTGRES_URI"));
  if (!["postgres:", "postgresql:"].includes(uri.protocol)) throw new Error("invalid_postgres_uri");
  const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("PG")));
  const keys = {
    host: "PGHOST",
    hostaddr: "PGHOSTADDR",
    port: "PGPORT",
    dbname: "PGDATABASE",
    user: "PGUSER",
    password: "PGPASSWORD",
    sslmode: "PGSSLMODE",
    sslrootcert: "PGSSLROOTCERT",
    sslcert: "PGSSLCERT",
    sslkey: "PGSSLKEY",
    sslcrl: "PGSSLCRL",
    sslcrldir: "PGSSLCRLDIR",
    channel_binding: "PGCHANNELBINDING",
    target_session_attrs: "PGTARGETSESSIONATTRS",
    application_name: "PGAPPNAME",
    gssencmode: "PGGSSENCMODE",
  };
  Object.assign(childEnv, {
    PGHOST: decodeURIComponent(uri.hostname).replace(/^\[|\]$/gu, ""),
    PGPORT: uri.port || "5432",
    PGDATABASE: decodeURIComponent(uri.pathname.slice(1)),
    PGUSER: decodeURIComponent(uri.username),
    PGPASSWORD: decodeURIComponent(uri.password),
  });
  for (const [key, value] of uri.searchParams) {
    if (!Object.hasOwn(keys, key)) throw new Error("unsupported_postgres_parameter");
    childEnv[keys[key]] = value;
  }
  if (!childEnv.PGHOST || !childEnv.PGDATABASE || !childEnv.PGUSER)
    throw new Error("explicit_postgres_target_required");
  // libpq does not expand a URI supplied as PGDATABASE. Map the URI to
  // explicit connection parameters; never fall back to a local default DB.
  childEnv.PGCONNECT_TIMEOUT = "5";
  childEnv.PGOPTIONS =
    "-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=15000";
  return childEnv;
}

/** SQL arrives on stdin. Neither credentials nor payloads appear in argv/errors. */
export function runReadOnlyPsql(sql, env, exec = execFile) {
  let childEnv;
  try {
    childEnv = reconcilePostgresEnv(env);
  } catch (error) {
    return Promise.reject(reconcileFailure(error, "config"));
  }
  return new Promise((accept, reject) => {
    const child = exec(
      "psql",
      ["-X", "-qAt", "--no-password", "-v", "ON_ERROR_STOP=1"],
      {
        env: childEnv,
        timeout: TIMEOUT,
        killSignal: "SIGKILL",
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) =>
        error ? reject(new ReconcileFailure("pg", { exit: error.code, stderr })) : accept(stdout),
    );
    child.stdin.on("error", () => {
      /* execFile's callback owns failure */
    });
    child.stdin.end(sql);
  });
}

export function createPostgresLookup(env, run = runReadOnlyPsql) {
  const functionId = required(env, "INNGEST_CAPTURE_FUNCTION_ID");
  if (!/^[a-f0-9-]{36}$/iu.test(functionId)) throw new Error("invalid_function_id");
  const days = integer(env.CAPTURE_RECONCILE_LOOKBACK_DAYS ?? "2", 365);
  return async (ids) => {
    if (!ids.length || ids.length > 200 || ids.some((id) => !/^[a-zA-Z0-9._:-]{1,200}$/u.test(id)))
      throw new Error("invalid_query_ids");
    const literals = ids.map((id) => `'${id}'`).join(",");
    // Base64 makes COPY text output unambiguous even when event_data contains
    // tabs, newlines or backslashes. Strip encode()'s wrapping inside SQL.
    // Inngest 1.46 stores function_runs.function_id as character(36), not uuid: compare as text.
    const select = `SELECT replace(encode(convert_to(COALESCE(json_agg(o),'[]'::json)::text,'UTF8'),'base64'),chr(10),'') FROM (
      SELECT e.event_data::jsonb->>'run_id' AS run_id,e.event_data,
        fr.run_id IS NOT NULL AS has_run,ff.status,ff.output
      FROM events e
      LEFT JOIN function_runs fr ON fr.event_id=e.internal_id AND fr.function_id='${functionId}'
      LEFT JOIN function_finishes ff ON ff.run_id=fr.run_id
      WHERE e.event_name='memory/run.captured'
        AND e.received_at > now() - interval '${days} days'
        AND e.event_data::jsonb->>'run_id'=ANY(ARRAY[${literals}]::text[])
      ORDER BY e.received_at DESC
    ) o`;
    const sql = `BEGIN TRANSACTION READ ONLY;\n\\copy (${select.replace(/\s+/gu, " ")}) TO STDOUT\nCOMMIT;\n`;
    try {
      const output = (await run(sql, env)).trim();
      if (!output || !/^[A-Za-z0-9+/]+={0,2}$/u.test(output))
        throw new Error("postgres_output_invalid");
      const rows = JSON.parse(Buffer.from(output, "base64").toString("utf8"));
      if (!Array.isArray(rows)) throw new Error("postgres_output_invalid");
      return rows.map((row) => {
        if (
          !ids.includes(row.run_id) ||
          typeof row.has_run !== "boolean" ||
          !(row.status === null || typeof row.status === "string")
        )
          throw new Error("postgres_output_invalid");
        let result = row.output;
        if (typeof result === "string") {
          try {
            result = JSON.parse(result);
          } catch {
            result = null;
          }
        }
        return { ...row, output: result };
      });
    } catch (error) {
      throw reconcileFailure(error, "pg");
    }
  };
}

export function createReconcileSender(env, fetchImpl = fetch) {
  const base = new URL(required(env, "INNGEST_BASE_URL"));
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password)
    throw new Error("invalid_event_url");
  const url = `${base.href.replace(/\/+$/u, "")}/e/${encodeURIComponent(required(env, "INNGEST_EVENT_KEY"))}`;
  return async (event) => {
    let status = null;
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(10_000),
      });
      status = response.status;
      if (!response.ok) throw new ReconcileFailure("post", { status });
      const receipt = await response.json();
      if (!Array.isArray(receipt.ids) || !receipt.ids.length)
        throw new ReconcileFailure("post", { status });
    } catch (error) {
      throw error instanceof ReconcileFailure ? error : new ReconcileFailure("post", { status });
    }
  };
}

/** @returns {{telemetry: import('@joelclaw/telemetry').TelemetryEmitter, flush: () => Promise<void>}} */
export function createReconcileTelemetry(env, apply, log = console.log, fetchImpl = fetch) {
  const pending = [];
  if (apply) required(env, "OTEL_EMIT_URL");
  const telemetry = {
    emit(action, detail, extra = {}) {
      if (!apply) return;
      const level = extra.level ?? "info";
      pending.push({
        id: randomUUID(),
        timestamp: Date.now(),
        action,
        level,
        source: "capture-cell",
        component: "capture-reconcile",
        sessionId: "capture-reconcile",
        systemId: env.SLOG_SYSTEM_ID ?? "capture-reconcile",
        success: level !== "error",
        metadata: { detail, ...extra },
      });
    },
  };
  return {
    telemetry,
    async flush() {
      for (const event of pending) {
        let response;
        try {
          response = await fetchImpl(env.OTEL_EMIT_URL, {
            method: "POST",
            redirect: "error",
            headers: {
              "content-type": "application/json",
              ...(env.OTEL_EMIT_TOKEN ? { "x-otel-emit-token": env.OTEL_EMIT_TOKEN } : {}),
            },
            body: JSON.stringify(event),
            signal: AbortSignal.timeout(5_000),
          });
          if (!response.ok) throw new ReconcileFailure("post", { status: response.status });
          await response.body?.cancel();
        } catch (error) {
          log("capture.reconcile.telemetry_failed");
          throw reconcileFailure(error, "post");
        }
      }
      pending.length = 0;
    },
  };
}

// Refuse symlink/hard-link aliases, not just equal path strings. A state DB
// must never accidentally turn the cell outbox or session index writable.
function checkPaths(cell, index, state) {
  assertSeparateReconcilePaths(cell, index, state);
  const sources = [cell, index].map((file) => ({ path: realpathSync(file), stat: statSync(file) }));
  if (existsSync(state)) {
    const stat = statSync(state);
    if (
      sources.some(
        (source) =>
          realpathSync(state) === source.path ||
          (stat.dev === source.stat.dev && stat.ino === source.stat.ino),
      )
    )
      throw new Error("database_paths_must_differ");
  }
}

export async function main(args, env = process.env) {
  if (args.includes("--help")) {
    console.log(USAGE);
    return 0;
  }
  let apply = false,
    limit = 20,
    loadLimit = 40;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--apply") apply = true;
    else if (args[i] === "--dry-run") apply = false;
    else if (args[i] === "--limit") limit = integer(args[++i], 1000);
    else if (args[i] === "--load-limit") loadLimit = integer(args[++i], 10000);
    else throw new Error("invalid_argument");
  }
  const waitAlarmMs = integer(
    env.RECONCILE_WAIT_ALARM_MS ?? String(DEFAULT_WAIT_ALARM_MS),
    Number.MAX_SAFE_INTEGER,
  );
  const { telemetry, flush } = createReconcileTelemetry(env, apply);
  if (loadavg()[0] > loadLimit) {
    console.log("capture.reconcile.skipped reason=load");
    telemetry.emit("capture.reconcile.skipped", "Load gate", { reason: "load" });
    await flush();
    return 0;
  }
  const cellPath = required(env, "CAPTURE_CELL_DB"),
    indexPath = required(env, "SESSION_INDEX_PATH");
  const statePath = required(env, "CAPTURE_RECONCILE_DB");
  checkPaths(cellPath, indexPath, statePath);
  const lookup = createPostgresLookup(env);
  const send = apply
    ? createReconcileSender(env)
    : async () => {
        throw new Error("dry_run_send");
      };
  let cell, index, state;
  try {
    cell = openReconcileSource(cellPath);
    try {
      index = openReconcileSource(indexPath);
    } catch (error) {
      throw reconcileFailure(error, "index");
    }
    state = apply
      ? openReconcileState(statePath)
      : existsSync(statePath)
        ? openReconcileSource(statePath)
        : openReconcileState(":memory:");
    const result = await reconcileCaptures({
      cell,
      index,
      state,
      lookup,
      send,
      telemetry,
      load: () => loadavg()[0],
      limit,
      loadLimit,
      waitAlarmMs,
      apply,
    });
    if (apply) await flushReconcileAlarms(state, telemetry, flush);
    return result.failed || result.gave_up || result.wait_alarmed ? 1 : 0;
  } catch (error) {
    const failure = reconcileFailure(error);
    if (!failure.logged)
      telemetry.emit("capture.reconcile.failed", "Reconciliation pass failed", {
        level: "error",
        ...failure.failure,
      });
    // Do not replace the actionable original failure if alarm delivery also fails.
    try {
      if (apply && state) await flushReconcileAlarms(state, telemetry, flush);
      else await flush();
    } catch {
      // Durable alarm receipts remain pending for the next pass.
    }
    throw failure;
  } finally {
    state?.close();
    index?.close();
    cell?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      if (!error.logged) logReconcileFailure(error);
      process.exitCode = 1;
    });
}
