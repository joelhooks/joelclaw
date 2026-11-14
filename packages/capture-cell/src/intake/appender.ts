import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { availableParallelism, loadavg } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SessionIndexReplacedError } from "@joelclaw/memory";
import type { TelemetryEmitter } from "@joelclaw/telemetry";
import { appendCapture } from "../append";
import { shadowAppend, walBytes } from "../shadow-append";
import type { AppendObservation, CapturedPayload } from "../types";
import { assertLegacyInline, assertLegacyMinimumSize } from "./legacy-body";
import { intakeMetadata } from "./server";
import { durableDirectory, type IntakeMetadata, type IntakeRow } from "./store";
import { MAX_INTAKE_BYTES, syncDirectory, writeAll } from "./stream";

export type AppenderState =
  | "idle"
  | "pulling"
  | "downloading"
  | "transferring"
  | "forwarding"
  | "returning"
  | "appending"
  | "comparing"
  | "acknowledging"
  | "backoff"
  | "load-gated"
  | "stopped";
export type AppenderObservation = AppendObservation | { readonly observed: "smoke-skipped" };
export interface AppenderOptions {
  url: string;
  token: string;
  runDir: string;
  sessionsDbPath: string;
  compareOnly: boolean;
  /** Remote rollback: forward to legacy instead of opening the local index. */
  deliverLegacy?: (metadata: IntakeMetadata, path: string) => Promise<void>;
  requestTimeoutMs?: number;
  readTimeoutMs?: number;
  walStopBytes?: number;
  fetch?: typeof fetch;
  /** Injectable host sample; load pressure yields, never denies work. */
  load?: () => { load1: number; cpus: number };
  now?: () => number;
  /** Soft high-load tick budget; finish each attempted row, default 3000ms. */
  loadBudgetMs?: number;
  onState?: (state: AppenderState) => void;
  telemetry?: TelemetryEmitter;
  observe?: (row: IntakeRow, observation: AppenderObservation) => void;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  pollMs?: number;
}
export interface TickResult {
  after: number;
  processed: number;
  failed: number;
  paused: boolean;
  pauseReason?: "load" | "wal";
  completed?: string[];
  failedRuns?: string[];
}
export function appenderBackoff(
  attempt: number,
  base = 1000,
  max = 300_000,
  random = Math.random,
): number {
  const ceiling = Math.min(max, base * 2 ** Math.min(Math.max(attempt - 1, 0), 20));
  return Math.floor(ceiling / 2 + (ceiling / 2) * random());
}
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("missing page body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.length;
      if (bytes > 32 * 1024 ** 2) throw new Error("owed page exceeds limit");
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
function checkedRow(value: unknown): IntakeRow {
  if (!value || typeof value !== "object") throw new Error("invalid owed row");
  const row = value as IntakeRow;
  const m = row.metadata;
  if (
    !Number.isSafeInteger(row.seq) ||
    row.seq <= 0 ||
    typeof row.id !== "string" ||
    !/^[0-9a-f-]{36}$/u.test(row.id) ||
    !m ||
    typeof m !== "object" ||
    typeof m.user_id !== "string" ||
    typeof m.machine_id !== "string" ||
    !Number.isSafeInteger(m.jsonl_bytes) ||
    m.jsonl_bytes <= 0 ||
    m.jsonl_bytes > MAX_INTAKE_BYTES ||
    typeof m.jsonl_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(m.jsonl_sha256)
  )
    throw new Error("invalid owed metadata");
  const metadata = intakeMetadata(
    m as unknown as Record<string, unknown>,
    m.jsonl_bytes,
    m.jsonl_sha256,
    { user_id: m.user_id },
    m.started_at,
  );
  return { ...row, metadata };
}

/** One serial index owner. Retry debt stays on intake, not in a local timer. */
export function createAppender(options: AppenderOptions) {
  if (!options.url || !options.token) throw new Error("appender needs intake URL and pull token");
  if (options.compareOnly && options.deliverLegacy)
    throw new Error("compare-only cannot transfer ownership");
  const doFetch = options.fetch ?? fetch;
  let state: AppenderState = "idle";
  const reportedReplacements = new WeakSet<SessionIndexReplacedError>();
  const transition = (next: AppenderState) => {
    state = next;
    try {
      options.onState?.(next);
      options.telemetry?.emit("capture.intake.appender.state", next, {
        compareOnly: options.compareOnly,
      });
    } catch {
      /* Observers never own capture delivery. */
    }
  };
  const walOver = () =>
    Boolean(options.sessionsDbPath) &&
    walBytes(options.sessionsDbPath) > (options.walStopBytes ?? 2 * 1024 ** 3);
  const load = options.load ?? (() => ({ load1: loadavg()[0] ?? 0, cpus: availableParallelism() }));
  const now = options.now ?? Date.now;
  // Gate sketch: normal --high--> gated --low--> normal; gated --10 min--> reminder.
  // WAL blocks dispatch separately. A load-gated result yields 2s without failure escalation.
  let loadGate: { mode: "normal" } | { mode: "gated"; remindAt: number } = { mode: "normal" };
  async function loadHigh(signal?: AbortSignal): Promise<boolean> {
    const sample = load();
    const ratio = sample.load1 / Math.max(1, sample.cpus);
    if (!(ratio > 0.8)) {
      loadGate = { mode: "normal" };
      return false;
    }
    if (loadGate.mode === "normal" || now() >= loadGate.remindAt) {
      loadGate = { mode: "gated", remindAt: now() + 10 * 60_000 };
      let depth: number | null = null;
      try {
        const health = (await request("/health", {}, boundedJson, signal, 1000)) as {
          depth?: unknown;
        };
        if (
          typeof health.depth === "number" &&
          Number.isSafeInteger(health.depth) &&
          health.depth >= 0
        )
          depth = health.depth;
      } catch {
        /* Health metadata cannot block the trickle; probe is bounded to 1s. */
      }
      try {
        options.telemetry?.emit(
          "capture.intake.appender.load_gated",
          "High load: trickling within the tick budget",
          {
            load: ratio,
            load1: sample.load1,
            cpus: sample.cpus,
            depth,
          },
        );
      } catch {
        /* Alarm delivery cannot own capture delivery. */
      }
    }
    return true;
  }
  async function request<T>(
    path: string,
    init: RequestInit,
    consume: (response: Response) => Promise<T>,
    signal?: AbortSignal,
    timeoutMs = options.requestTimeoutMs ?? 300_000,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response | undefined;
    try {
      response = await doFetch(`${options.url.replace(/\/+$/u, "")}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${options.token}`, ...init.headers },
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      });
      if (!response.ok) throw new Error(`intake HTTP ${response.status}`);
      return await consume(response);
    } finally {
      clearTimeout(timer);
      if (response?.body && !response.body.locked)
        await response.body.cancel().catch(() => undefined);
    }
  }
  async function download(row: IntakeRow, signal?: AbortSignal): Promise<string> {
    durableDirectory(options.runDir);
    const final = join(options.runDir, `${row.id}.jsonl`);
    const temporary = join(options.runDir, `${row.id}.${randomUUID()}.part`);
    const fd = openSync(temporary, "wx", 0o600);
    try {
      await request(
        `/blob/${encodeURIComponent(row.id)}`,
        {},
        async (response) => {
          if (!response.body) throw new Error("missing blob body");
          const reader = response.body.getReader();
          const hash = createHash("sha256");
          let bytes = 0;
          try {
            for (;;) {
              const next = await reader.read();
              if (next.done) break;
              bytes += next.value.length;
              if (bytes > row.metadata.jsonl_bytes) throw new Error("blob size exceeds metadata");
              hash.update(next.value);
              writeAll(fd, next.value);
            }
            if (
              bytes !== row.metadata.jsonl_bytes ||
              hash.digest("hex") !== row.metadata.jsonl_sha256
            )
              throw new Error("blob digest mismatch");
          } finally {
            await reader.cancel().catch(() => undefined);
            reader.releaseLock();
          }
        },
        signal,
      );
      fsyncSync(fd);
      if (existsSync(final) && statSync(final).size !== row.metadata.jsonl_bytes)
        throw new Error("local blob conflict");
      renameSync(temporary, final);
      syncDirectory(options.runDir);
      return final;
    } finally {
      closeSync(fd);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  async function page(
    after = 0,
    includeLegacy = false,
    signal?: AbortSignal,
  ): Promise<IntakeRow[]> {
    const result = (await request(
      `/owed?after=${after}&limit=100${includeLegacy ? "&include_legacy=1" : ""}`,
      {},
      boundedJson,
      signal,
    )) as { items?: unknown[] };
    if (!Array.isArray(result.items) || result.items.length > 100)
      throw new Error("invalid owed page");
    return result.items.map(checkedRow);
  }
  async function claimLegacy(
    row: IntakeRow,
    legacyOnly = false,
    signal?: AbortSignal,
  ): Promise<string | null> {
    transition("transferring");
    const transfer = (await request(
      "/transfer",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: row.id,
          jsonl_sha256: row.metadata.jsonl_sha256,
          legacy_only: legacyOnly,
          expected_epoch: row.transfer_epoch,
        }),
      },
      boundedJson,
      signal,
    )) as { ok?: boolean; transferred?: boolean; transfer_token?: string };
    if (transfer.ok !== true || typeof transfer.transferred !== "boolean")
      throw new Error("ambiguous ownership transfer");
    if (!transfer.transferred) return null;
    if (
      typeof transfer.transfer_token !== "string" ||
      !/^[0-9a-f-]{36}$/u.test(transfer.transfer_token)
    )
      throw new Error("missing transfer capability");
    return transfer.transfer_token;
  }
  async function transferBack(row: IntakeRow): Promise<boolean> {
    const token = await claimLegacy(row, true);
    if (!token) return false;
    transition("returning");
    await request(
      "/transfer-back",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: row.id,
          jsonl_sha256: row.metadata.jsonl_sha256,
          transfer_token: token,
        }),
      },
      async (response) => {
        const result = (await boundedJson(response)) as { returned?: boolean };
        if (result.returned !== true) throw new Error("ambiguous transfer-back");
      },
    );
    transition("idle");
    return true;
  }
  async function tick(after = 0, signal?: AbortSignal): Promise<TickResult> {
    const startedAt = now();
    if (walOver()) {
      transition("backoff");
      return { after, processed: 0, failed: 0, paused: true, pauseReason: "wal" };
    }
    let trickle = await loadHigh(signal);
    transition("pulling");
    const rows = await page(after, Boolean(options.deliverLegacy), signal);
    let processed = 0;
    let failed = 0;
    const completed: string[] = [];
    const failedRuns: string[] = [];
    let cursor = after;
    let attempted = 0;
    for (const row of rows) {
      if (row.seq <= cursor) throw new Error("non-increasing owed cursor");
      if (signal?.aborted) break;
      if (walOver()) {
        transition("backoff");
        return {
          after: 0,
          processed,
          failed,
          paused: true,
          pauseReason: "wal",
          completed,
          failedRuns,
        };
      }
      const high = await loadHigh(signal);
      trickle = trickle || high;
      if (trickle && attempted >= 1 && now() - startedAt >= (options.loadBudgetMs ?? 3000)) break;
      if (signal?.aborted) break;
      cursor = row.seq;
      attempted++;
      try {
        const smoke =
          row.metadata.machine_id === "intake-smoke" ||
          row.metadata.tags?.includes("synthetic:intake-smoke") === true;
        let transferToken: string | undefined;
        if (smoke) {
          // Old smoke rows have no tag. Never turn synthetic user text into a quote.
          // Remote rollback can also see legacy-owned debt; keep its ack fence.
          if (options.deliverLegacy && row.owner === "legacy") {
            const token = await claimLegacy(row, true, signal);
            if (!token) continue;
            transferToken = token;
          }
        } else {
          if (options.deliverLegacy) assertLegacyMinimumSize(row.metadata);
          transition("downloading");
          const path = await download(row, signal);
          if (options.deliverLegacy) {
            await assertLegacyInline(row.metadata, path);
            const token = await claimLegacy(row, false, signal);
            if (!token) continue; // The transfer UPDATE, not its earlier snapshot, owns this decision.
            transferToken = token;
            transition("forwarding");
            await options.deliverLegacy(row.metadata, path);
          } else {
            // Recheck after network/file I/O; an over-limit WAL must never get another append.
            if (walOver()) {
              transition("backoff");
              return {
                after: 0,
                processed,
                failed,
                paused: true,
                pauseReason: "wal",
                completed,
                failedRuns,
              };
            }
            const payload: CapturedPayload = { ...row.metadata, jsonl_path: path };
            transition(options.compareOnly ? "comparing" : "appending");
            const bounds = {
              sessionsDbPath: options.sessionsDbPath,
              readTimeoutMs: options.readTimeoutMs ?? 3000,
              onCursorIndexMissing: () =>
                options.telemetry?.emit(
                  "capture.session_index.cursor_index_missing",
                  "Run capture-intake index-migrate with writers quiesced",
                  { command: "capture-intake index-migrate --db <sessions-db>" },
                ),
            };
            const observation = options.compareOnly
              ? shadowAppend(payload, bounds)
              : appendCapture(payload, bounds);
            options.observe?.(row, observation);
            if (!options.compareOnly) {
              try {
                options.telemetry?.emit("memory.run.session-index.append", "session-index append", {
                  component: "capture-appender",
                  duration_ms: observation.duration_ms,
                  canonical_duration_ms: observation.canonical_duration_ms,
                  run_id: row.run_id,
                  status: observation.observed,
                  agent_runtime: row.metadata.agent_runtime,
                  chunk_count: observation.chunk_count,
                  turn_count: observation.turn_count,
                  jsonl_bytes: row.metadata.jsonl_bytes,
                  text_bytes: observation.text_bytes,
                  phase_ms: observation.phase_ms,
                });
              } catch {
                /* Telemetry cannot own durable acknowledgement. */
              }
            }
          }
        }
        if (!options.compareOnly) {
          transition("acknowledging");
          await request(
            "/ack",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                id: row.id,
                jsonl_sha256: row.metadata.jsonl_sha256,
                transfer_token: transferToken,
              }),
            },
            async (response) => {
              const ack = (await boundedJson(response)) as { ok?: boolean };
              if (ack.ok !== true) throw new Error("ambiguous intake acknowledgement");
            },
            signal,
          );
        }
        if (smoke) {
          try {
            options.observe?.(row, { observed: "smoke-skipped" });
            options.telemetry?.emit("capture.intake.appender.smoke_skipped", "smoke-skipped", {
              run_id: row.run_id,
              observed: "smoke-skipped",
              compareOnly: options.compareOnly,
            });
          } catch {
            /* Observers never own smoke acknowledgement. */
          }
        }
        processed++;
        completed.push(row.run_id);
      } catch (error) {
        if (error instanceof SessionIndexReplacedError && !reportedReplacements.has(error)) {
          reportedReplacements.add(error);
          try {
            options.telemetry?.emit("capture.intake.appender.session_index_replaced", error.code, {
              run_id: row.run_id,
              code: error.code,
            });
          } catch {
            /* The poisoned index stays fenced and the capture remains owed. */
          }
        }
        failed++;
        failedRuns.push(row.run_id);
      }
    }
    transition(trickle ? "load-gated" : "idle");
    return {
      after: rows.length ? cursor : 0,
      processed,
      failed,
      paused: trickle,
      ...(trickle ? { pauseReason: "load" as const } : {}),
      completed,
      failedRuns,
    };
  }
  async function run(signal: AbortSignal): Promise<void> {
    let after = 0;
    let attempt = 0;
    const wait =
      options.wait ?? ((ms: number, abort: AbortSignal) => delay(ms, undefined, { signal: abort }));
    try {
      while (!signal.aborted) {
        let result: TickResult | undefined;
        try {
          result = await tick(after, signal);
          after = result.after;
        } catch {
          after = 0;
        }
        if (signal.aborted) break;
        const failed = !result || result.failed > 0 || result.pauseReason === "wal";
        attempt = failed ? attempt + 1 : 0;
        const softPause = !failed && result?.pauseReason === "load";
        transition(failed ? "backoff" : softPause ? "load-gated" : "idle");
        const ms = failed
          ? appenderBackoff(attempt, options.baseBackoffMs, options.maxBackoffMs, options.random)
          : softPause
            ? 2000
            : result?.after
              ? 0
              : (options.pollMs ?? 5000);
        await wait(ms, signal);
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      transition("stopped");
    }
  }
  return { page, tick, run, transferBack, state: () => state };
}
