import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { AgentRuntime } from "@joelclaw/memory";
import type { IntakeIdentities } from "./identities";
import { assertLegacyInline } from "./legacy-body";
import {
  acknowledge,
  blobPath,
  commitIntake,
  getRow,
  type IntakeMetadata,
  type IntakeStore,
  intakeHealth,
  owedPage,
  transferBackToAppender,
  transferToLegacy,
} from "./store";
import { IntakeRequestError, MAX_INTAKE_BYTES, receiveInlineBody, syncDirectory } from "./stream";

export interface IntakePrincipal {
  user_id: string;
}
export interface IntakeServerOptions {
  store: IntakeStore;
  ingestToken: string;
  pullToken: string;
  principal: IntakePrincipal;
  identities?: IntakeIdentities;
  now?: () => number;
  maxBytes?: number;
  /** Fault-injection seams run synchronously at actual durability boundaries. */
  beforeBlobSync?: () => void;
  afterBlobSync?: () => void;
  afterCommit?: () => void;
}
const runtimes = new Set([
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
function reject(code = "invalid_run_capture"): never {
  throw new IntakeRequestError(400, code);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 1024;
}
export function intakeMetadata(
  raw: Record<string, unknown>,
  bytes: number,
  digest: string,
  principal: IntakePrincipal,
  now: number,
): IntakeMetadata {
  if (!runtimes.has(raw.agent_runtime as string) || raw.jsonl_path !== undefined) reject();
  if (!text(raw.machine_id)) reject("machine_id_required");
  const hasCursor =
    raw.source_identity !== undefined ||
    raw.from_offset !== undefined ||
    raw.to_offset !== undefined;
  if (
    hasCursor &&
    (typeof raw.source_identity !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(raw.source_identity) ||
      !Number.isSafeInteger(raw.from_offset) ||
      !Number.isSafeInteger(raw.to_offset) ||
      (raw.from_offset as number) < 0 ||
      (raw.to_offset as number) - (raw.from_offset as number) !== bytes ||
      raw.jsonl_sha256 !== digest)
  )
    reject();
  if (raw.jsonl_sha256 !== undefined && raw.jsonl_sha256 !== digest) reject("blob_digest_mismatch");
  if (raw.jsonl_bytes !== undefined && raw.jsonl_bytes !== bytes) reject("blob_size_mismatch");
  if (raw.run_id !== undefined && !text(raw.run_id)) reject("run_id_required");
  if (!hasCursor && !text(raw.run_id)) reject("run_id_required");
  if (
    raw.started_at !== undefined &&
    (!Number.isSafeInteger(raw.started_at) || (raw.started_at as number) < 0)
  )
    reject();
  for (const key of ["parent_run_id", "conversation_id"] as const)
    if (raw[key] !== undefined && raw[key] !== null && !text(raw[key])) reject();
  if (
    raw.tags !== undefined &&
    (!Array.isArray(raw.tags) || raw.tags.length > 256 || !raw.tags.every(text))
  )
    reject();
  const runId =
    (raw.run_id as string | undefined) ??
    createHash("sha256")
      .update(JSON.stringify([principal.user_id, raw.source_identity, raw.from_offset]))
      .digest("hex");
  return {
    run_id: runId,
    user_id: principal.user_id,
    machine_id: raw.machine_id as string,
    agent_runtime: raw.agent_runtime as AgentRuntime,
    started_at: (raw.started_at as number | undefined) ?? now,
    jsonl_bytes: bytes,
    jsonl_sha256: digest,
    ...(raw.parent_run_id ? { parent_run_id: raw.parent_run_id as string } : {}),
    ...(raw.conversation_id ? { conversation_id: raw.conversation_id as string } : {}),
    tags: (raw.tags as string[] | undefined) ?? [],
    ...(hasCursor
      ? {
          source_identity: raw.source_identity as string,
          from_offset: raw.from_offset as number,
          to_offset: raw.to_offset as number,
        }
      : {}),
  };
}
function authorized(request: Request, expected: string): boolean {
  const actual = request.headers.get("authorization");
  if (!actual || !expected) return false;
  const a = createHash("sha256").update(actual).digest();
  const b = createHash("sha256").update(`Bearer ${expected}`).digest();
  return timingSafeEqual(a, b);
}
async function ackBody(request: Request): Promise<{
  id: string;
  jsonl_sha256: string;
  transfer_token?: string;
  legacy_only?: boolean;
  expected_epoch?: number;
}> {
  if (!request.body) reject();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > 4096) throw new IntakeRequestError(413, "ack_too_large");
      chunks.push(part.value);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    if (!value || !text(value.id) || typeof value.jsonl_sha256 !== "string") reject();
    if (value.transfer_token !== undefined && !text(value.transfer_token)) reject();
    if (value.legacy_only !== undefined && typeof value.legacy_only !== "boolean") reject();
    if (
      value.expected_epoch !== undefined &&
      (!Number.isSafeInteger(value.expected_epoch) || (value.expected_epoch as number) < 0)
    )
      reject();
    return {
      id: value.id,
      jsonl_sha256: value.jsonl_sha256,
      transfer_token: value.transfer_token as string | undefined,
      legacy_only: value.legacy_only as boolean | undefined,
      expected_epoch: value.expected_epoch as number | undefined,
    };
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof SyntaxError) reject();
    throw error;
  } finally {
    reader.releaseLock();
  }
}
export function createIntakeHandler(
  options: IntakeServerOptions,
): (request: Request) => Promise<Response> {
  if (
    !options.ingestToken ||
    !options.pullToken ||
    options.ingestToken === options.pullToken ||
    !text(options.principal.user_id)
  )
    throw new Error("intake needs distinct ingest/pull tokens and a principal");
  const { store } = options;
  const now = options.now ?? Date.now;
  const active = store.publishing;
  return async (request) => {
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health")
        return Response.json(intakeHealth(store, now()));
      const ingest = request.method === "POST" && url.pathname === "/api/runs";
      if (ingest) options.identities?.reload();
      // The configured ingest token keeps its original principal/payload semantics.
      // Machine identities can ingest only; they never participate in pull auth.
      const sharedIngest = ingest && authorized(request, options.ingestToken);
      const identity =
        ingest && !sharedIngest
          ? options.identities?.lookup(request.headers.get("authorization"))
          : null;
      if (ingest ? !sharedIngest && !identity : !authorized(request, options.pullToken))
        return Response.json({ ok: false, error: { code: "unauthorized" } }, { status: 401 });
      if (ingest) {
        if (active.size >= 4) {
          await request.body?.cancel().catch(() => undefined);
          throw new IntakeRequestError(503, "intake_busy");
        }
        const id = randomUUID();
        const temporary = join(store.blobDir, `${id}.part`);
        const final = blobPath(store, id);
        active.add(id);
        let fd: number | undefined;
        try {
          fd = openSync(temporary, "wx", 0o600);
          const received = await receiveInlineBody(
            request,
            fd,
            options.maxBytes ?? MAX_INTAKE_BYTES,
          );
          const metadata = intakeMetadata(
            identity
              ? { ...received.metadata, machine_id: identity.machine_id }
              : received.metadata,
            received.bytes,
            received.sha256,
            identity ? { user_id: identity.user_id } : options.principal,
            now(),
          );
          options.beforeBlobSync?.();
          fsyncSync(fd);
          options.afterBlobSync?.();
          renameSync(temporary, final);
          syncDirectory(store.blobDir);
          const row = await commitIntake(store, id, metadata, now());
          if (row.id !== id) {
            const original = blobPath(store, row.id);
            if (row.pruned_at === null && !existsSync(original)) {
              renameSync(final, original); // repair a missing copy from a verified retry
              syncDirectory(store.blobDir);
            } else unlinkSync(final); // duplicate's private, unreferenced copy
          }
          options.afterCommit?.();
          return Response.json(
            {
              ok: true,
              run_id: row.run_id,
              started_at: row.metadata.started_at,
              id: row.id,
              jsonl_bytes: row.metadata.jsonl_bytes,
              jsonl_sha256: row.metadata.jsonl_sha256,
              user_id: row.metadata.user_id,
              machine_id: row.metadata.machine_id,
              to_offset: row.metadata.to_offset,
              status:
                row.metadata.jsonl_bytes < metadata.jsonl_bytes ? "accepted_prefix" : "accepted",
            },
            { status: 202 },
          );
        } finally {
          active.delete(id);
          if (fd !== undefined) closeSync(fd);
          // A published file is never removed on an ambiguous commit failure.
          if (existsSync(temporary)) unlinkSync(temporary);
        }
      }
      if (request.method === "GET" && url.pathname === "/owed") {
        const after = Number(url.searchParams.get("after") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? 100);
        const items = owedPage(store, after, limit, url.searchParams.get("include_legacy") === "1");
        return Response.json({ items, next_after: items.at(-1)?.seq ?? null });
      }
      if (request.method === "GET" && url.pathname.startsWith("/blob/")) {
        const id = url.pathname.slice("/blob/".length);
        const path = blobPath(store, id);
        const row = getRow(store, id);
        if (!row) return new Response(null, { status: 404 });
        if (row.pruned_at !== null) return new Response(null, { status: 410 });
        if (!existsSync(path)) throw new Error("committed blob missing");
        return new Response(Bun.file(path).stream(), {
          headers: {
            "content-type": "application/x-ndjson",
            "content-length": String(row.metadata.jsonl_bytes),
            "x-content-sha256": row.metadata.jsonl_sha256,
          },
        });
      }
      if (request.method === "POST" && url.pathname === "/transfer") {
        const transfer = await ackBody(request);
        const row = getRow(store, transfer.id);
        if (!row || row.metadata.jsonl_sha256 !== transfer.jsonl_sha256)
          return Response.json({ ok: false }, { status: 409 });
        if (transfer.expected_epoch !== undefined && transfer.expected_epoch !== row.transfer_epoch)
          return Response.json({ ok: true, transferred: false });
        // Recovery only renews a current legacy capability; it cannot reclaim
        // appender rows and must work even for old oversized/missing blobs.
        if (row.acked_at === null && !transfer.legacy_only)
          await assertLegacyInline(row.metadata, blobPath(store, row.id));
        const result = transferToLegacy(
          store,
          row.id,
          transfer.jsonl_sha256,
          transfer.legacy_only,
          row.transfer_epoch,
        );
        return Response.json({ ok: true, ...result });
      }
      if (request.method === "POST" && url.pathname === "/transfer-back") {
        const ack = await ackBody(request);
        const returned =
          ack.transfer_token !== undefined &&
          transferBackToAppender(store, ack.id, ack.jsonl_sha256, ack.transfer_token);
        return Response.json({ ok: returned, returned }, { status: returned ? 200 : 409 });
      }
      if (request.method === "POST" && url.pathname === "/ack") {
        const ack = await ackBody(request);
        const ok = acknowledge(store, ack.id, ack.jsonl_sha256, now(), ack.transfer_token);
        return Response.json({ ok }, { status: ok ? 200 : 409 });
      }
      return new Response(null, { status: 404 });
    } catch (error) {
      const known = error instanceof IntakeRequestError;
      return Response.json(
        { ok: false, error: { code: known ? error.code : "capture_intake_unavailable" } },
        { status: known ? error.status : 503 },
      );
    }
  };
}
