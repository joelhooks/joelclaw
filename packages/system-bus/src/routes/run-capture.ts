import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  type AgentRuntime,
  RunBlobConflictError,
  type RunBlobWriteResult,
  runStoreBase,
} from "@joelclaw/memory";
import type { Context, Hono } from "hono";
import { isProtectedHarnessPath } from "../lib/protected-harness-paths";
import {
  DEFAULT_RUN_CAPTURE_CLAIM_CHECK_SPOOL_DIR,
  DEFAULT_RUN_CAPTURE_MAX_CLAIM_CHECK_BYTES,
  readRunCaptureClaimCheck,
} from "./run-capture-claim-check";

// Recent v12 capture segments exceed 2 MB; keep this aligned with the Pi client default.
export const DEFAULT_RUN_CAPTURE_MAX_INLINE_BYTES = 10_000_000;

const VALID_RUN_RUNTIMES: AgentRuntime[] = [
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
];

export type MemoryIdentity = {
  user_id: string;
  machine_id: string;
  did: string | null;
};

type RunIngestRequest = {
  run_id?: string;
  agent_runtime?: AgentRuntime;
  started_at?: number;
  parent_run_id?: string | null;
  conversation_id?: string | null;
  tags?: string[];
  jsonl?: string;
  jsonl_path?: string;
  from_offset?: number;
  to_offset?: number;
  jsonl_sha256?: string;
  source_identity?: string;
};

type ParsedRunIngestRequest = RunIngestRequest & {
  agent_runtime: AgentRuntime;
  jsonl: string;
};

type CapturedRunEvent = {
  name: "memory/run.captured";
  data: {
    run_id: string;
    user_id: string;
    machine_id: string;
    agent_runtime: AgentRuntime;
    jsonl_path: string;
    jsonl_bytes: number;
    jsonl_sha256: string;
    started_at: number;
    parent_run_id?: string;
    conversation_id?: string;
    tags: string[];
    from_offset?: number;
    to_offset?: number;
    source_identity?: string;
  };
};

type SourceCursorClaim = {
  run_id: string;
  started_at: number;
  created: boolean;
};

const sourceCursorQueues = new Map<string, Promise<void>>();

type StoredSourceCursorClaim = {
  state: "active" | "released";
  run_id: string;
  started_at: number;
};

function sourceCursorKey(sourceIdentity: string, fromOffset: number): string {
  return createHash("sha256")
    .update(JSON.stringify([sourceIdentity, fromOffset]))
    .digest("hex");
}

function sourceCursorClaimPath(
  root: string,
  userId: string,
  sourceIdentity: string,
  fromOffset: number,
): string {
  const userKey = createHash("sha256").update(userId).digest("hex");
  return join(root, userKey, `${sourceCursorKey(sourceIdentity, fromOffset)}.json`);
}

function legacySourceCursorClaimPath(
  userId: string,
  sourceIdentity: string,
  fromOffset: number,
): string {
  return join(
    runStoreBase(),
    userId,
    ".source-cursors",
    `${sourceCursorKey(sourceIdentity, fromOffset)}.json`,
  );
}

function readSourceCursorClaim(path: string): StoredSourceCursorClaim | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as {
      state?: unknown;
      run_id?: unknown;
      started_at?: unknown;
    };
    if (
      (value.state === undefined || value.state === "active" || value.state === "released") &&
      typeof value.run_id === "string" &&
      Number.isSafeInteger(value.started_at)
    ) {
      return {
        state: value.state === "released" ? "released" : "active",
        run_id: value.run_id,
        started_at: value.started_at as number,
      };
    }
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

function writeSourceCursorClaim(path: string, claim: StoredSourceCursorClaim): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, JSON.stringify(claim), { mode: 0o600 });
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Preserve the write/rename failure; a leftover temp file is harmless metadata.
    }
    throw error;
  }
}

function claimSourceCursor(
  claimRoot: string,
  userId: string,
  sourceIdentity: string,
  fromOffset: number,
  runId: string,
  startedAt: number,
): SourceCursorClaim {
  const path = sourceCursorClaimPath(claimRoot, userId, sourceIdentity, fromOffset);
  const current = readSourceCursorClaim(path);
  if (current?.state === "active") {
    return { run_id: current.run_id, started_at: current.started_at, created: false };
  }

  if (!current) {
    const legacy = readSourceCursorClaim(
      legacySourceCursorClaimPath(userId, sourceIdentity, fromOffset),
    );
    if (legacy?.state === "active") {
      writeSourceCursorClaim(path, legacy);
      return { run_id: legacy.run_id, started_at: legacy.started_at, created: false };
    }
  }

  const next: StoredSourceCursorClaim = { state: "active", run_id: runId, started_at: startedAt };
  writeSourceCursorClaim(path, next);
  return { run_id: runId, started_at: startedAt, created: true };
}

function releaseSourceCursorClaim(
  claimRoot: string,
  userId: string,
  sourceIdentity: string,
  fromOffset: number,
  claim: SourceCursorClaim,
): void {
  const path = sourceCursorClaimPath(claimRoot, userId, sourceIdentity, fromOffset);
  const existing = readSourceCursorClaim(path);
  if (
    existing?.state === "active" &&
    existing.run_id === claim.run_id &&
    existing.started_at === claim.started_at
  ) {
    writeSourceCursorClaim(path, { ...existing, state: "released" });
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

function resolveSafeSourceCursorClaimDir(path: string): string {
  let existingAncestor = resolve(path);
  const missingSegments: string[] = [];
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor)
      throw new Error("could not resolve source cursor claim storage");
    missingSegments.unshift(basename(existingAncestor));
    existingAncestor = parent;
  }

  const canonicalPath = resolve(realpathSync(existingAncestor), ...missingSegments);
  const runStorePath = resolve(runStoreBase());
  const canonicalRunStore = existsSync(runStorePath) ? realpathSync(runStorePath) : runStorePath;
  if (isPathInside(canonicalRunStore, canonicalPath) || isProtectedHarnessPath(canonicalPath)) {
    throw new Error("source cursor claim storage must be outside protected harness paths");
  }
  return canonicalPath;
}

async function withSourceCursorLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const prior = sourceCursorQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prior.catch(() => undefined).then(() => current);
  sourceCursorQueues.set(key, tail);
  await prior.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (sourceCursorQueues.get(key) === tail) sourceCursorQueues.delete(key);
  }
}

export type RunCaptureRouteDependencies = {
  authenticate: (context: Context) => Promise<MemoryIdentity | null>;
  maxInlineBytes?: number;
  maxClaimCheckBytes?: number;
  claimCheckSpoolDir?: string;
  sourceCursorClaimDir?: string;
  writeRunBlob: (
    userId: string,
    runId: string,
    startedAt: number,
    jsonl: string,
    metadata: Record<string, unknown>,
  ) => RunBlobWriteResult;
  sendCaptured: (event: CapturedRunEvent) => Promise<unknown>;
  now?: () => number;
  newRunId?: () => string;
};

function isValidClaimCheckMetadata(body: RunIngestRequest): boolean {
  if (
    typeof body.jsonl_path !== "string" ||
    body.jsonl !== undefined ||
    body.agent_runtime === undefined ||
    !VALID_RUN_RUNTIMES.includes(body.agent_runtime) ||
    typeof body.jsonl_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(body.jsonl_sha256)
  ) {
    return false;
  }
  const hasSourceCursor =
    body.from_offset !== undefined ||
    body.to_offset !== undefined ||
    body.source_identity !== undefined;
  if (!hasSourceCursor) return true;
  return (
    Number.isSafeInteger(body.from_offset) &&
    Number.isSafeInteger(body.to_offset) &&
    (body.from_offset as number) >= 0 &&
    (body.to_offset as number) >= (body.from_offset as number) &&
    typeof body.source_identity === "string" &&
    /^sha256:[0-9a-f]{64}$/u.test(body.source_identity)
  );
}

function parseRunBody(value: unknown): ParsedRunIngestRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as RunIngestRequest;
  if (body.jsonl_path !== undefined || !body.jsonl || typeof body.jsonl !== "string") return null;
  if (!body.agent_runtime || !VALID_RUN_RUNTIMES.includes(body.agent_runtime)) return null;
  const { from_offset: fromOffset, to_offset: toOffset } = body;
  const hasSourceCursor =
    fromOffset !== undefined || toOffset !== undefined || body.source_identity !== undefined;
  const bodySha256 = createHash("sha256").update(body.jsonl).digest("hex");
  if (hasSourceCursor) {
    if (
      !Number.isSafeInteger(fromOffset) ||
      !Number.isSafeInteger(toOffset) ||
      (fromOffset as number) < 0 ||
      (toOffset as number) < (fromOffset as number) ||
      (toOffset as number) - (fromOffset as number) !== Buffer.byteLength(body.jsonl, "utf8") ||
      body.jsonl_sha256 !== bodySha256 ||
      typeof body.source_identity !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(body.source_identity)
    ) {
      return null;
    }
  } else if (body.jsonl_sha256 !== undefined && body.jsonl_sha256 !== bodySha256) {
    return null;
  }
  return body as ParsedRunIngestRequest;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseContentLength(request: Request): number | undefined {
  const value = request.headers.get("content-length");
  if (!value || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

type LimitedJsonBody =
  | { kind: "parsed"; value: unknown }
  | { kind: "too_large"; actualBytes: number }
  | { kind: "invalid" };

async function readJsonBodyWithinLimit(
  request: Request,
  maxBytes: number,
): Promise<LimitedJsonBody> {
  const reader = request.body?.getReader();
  if (!reader) return { kind: "invalid" };

  const chunks: Uint8Array[] = [];
  let actualBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      actualBytes += value.byteLength;
      if (actualBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { kind: "too_large", actualBytes };
      }
      chunks.push(value);
    }
  } catch {
    return { kind: "invalid" };
  } finally {
    reader.releaseLock();
  }

  const bytes = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    actualBytes,
  );
  try {
    return { kind: "parsed", value: JSON.parse(bytes.toString("utf8")) as unknown };
  } catch {
    return { kind: "invalid" };
  }
}

function defaultRunId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 26);
}

export function registerRunCaptureRoute(
  app: Hono,
  dependencies: RunCaptureRouteDependencies,
): void {
  const now = dependencies.now ?? Date.now;
  const newRunId = dependencies.newRunId ?? defaultRunId;
  const maxInlineBytes =
    dependencies.maxInlineBytes ??
    positiveInteger(process.env.RUN_CAPTURE_MAX_INLINE_BYTES, DEFAULT_RUN_CAPTURE_MAX_INLINE_BYTES);
  const claimCheckSpoolDir =
    dependencies.claimCheckSpoolDir ?? DEFAULT_RUN_CAPTURE_CLAIM_CHECK_SPOOL_DIR;
  const sourceCursorClaimDir = resolveSafeSourceCursorClaimDir(
    dependencies.sourceCursorClaimDir ?? join(homedir(), ".joelclaw", "run-capture-cursors"),
  );
  const maxClaimCheckBytes =
    dependencies.maxClaimCheckBytes ?? DEFAULT_RUN_CAPTURE_MAX_CLAIM_CHECK_BYTES;

  app.post("/api/runs", async (context) => {
    const request = context.req.raw;
    const declaredBytes = parseContentLength(request);
    if (declaredBytes !== undefined && declaredBytes > maxInlineBytes) {
      return context.json(
        {
          ok: false,
          error: {
            code: "run_capture_payload_too_large",
            message: "Run capture body exceeds the configured inline limit",
            max_bytes: maxInlineBytes,
            actual_bytes: declaredBytes,
          },
        },
        413,
      );
    }

    const auth = await dependencies.authenticate(context);
    if (!auth) {
      return context.json({ ok: false, error: { code: "unauthorized" } }, 401);
    }

    const limitedBody = await readJsonBodyWithinLimit(request, maxInlineBytes);
    if (limitedBody.kind === "too_large") {
      return context.json(
        {
          ok: false,
          error: {
            code: "run_capture_payload_too_large",
            message: "Run capture body exceeds the configured inline limit",
            max_bytes: maxInlineBytes,
            actual_bytes: limitedBody.actualBytes,
          },
        },
        413,
      );
    }
    const rawBody = limitedBody.kind === "parsed" ? limitedBody.value : null;
    let body = parseRunBody(rawBody);
    if (
      !body &&
      rawBody &&
      typeof rawBody === "object" &&
      !Array.isArray(rawBody) &&
      isValidClaimCheckMetadata(rawBody as RunIngestRequest)
    ) {
      const claimCheck = rawBody as RunIngestRequest;
      const jsonl = readRunCaptureClaimCheck(
        claimCheck.jsonl_path,
        claimCheck.jsonl_sha256,
        claimCheckSpoolDir,
        maxClaimCheckBytes,
      );
      if (jsonl !== null) body = parseRunBody({ ...claimCheck, jsonl, jsonl_path: undefined });
    }
    if (!body) {
      return context.json(
        {
          ok: false,
          error: {
            code: "invalid_run_capture",
            message: "Body must include JSONL or a valid claim-check path and agent_runtime",
          },
        },
        400,
      );
    }

    const requestedRunId = body.run_id ?? newRunId();
    const requestedStartedAt = body.started_at ?? now();
    const tags = Array.isArray(body.tags) ? body.tags.filter((tag) => typeof tag === "string") : [];
    const cursorKey =
      body.source_identity !== undefined && body.from_offset !== undefined
        ? `${auth.user_id}:${body.source_identity}:${body.from_offset}`
        : `legacy:${auth.user_id}:${requestedRunId}`;

    return withSourceCursorLock(cursorKey, async () => {
      const claim =
        body.source_identity !== undefined && body.from_offset !== undefined
          ? claimSourceCursor(
              sourceCursorClaimDir,
              auth.user_id,
              body.source_identity,
              body.from_offset,
              requestedRunId,
              requestedStartedAt,
            )
          : { run_id: requestedRunId, started_at: requestedStartedAt, created: true };
      const runId = claim.run_id;
      const startedAt = claim.started_at;
      let blob: RunBlobWriteResult;
      try {
        blob = dependencies.writeRunBlob(auth.user_id, runId, startedAt, body.jsonl, {
          run_id: runId,
          user_id: auth.user_id,
          machine_id: auth.machine_id,
          agent_runtime: body.agent_runtime,
          parent_run_id: body.parent_run_id ?? null,
          conversation_id: body.conversation_id ?? null,
          tags,
          started_at: startedAt,
          captured_at: now(),
          from_offset: body.from_offset ?? null,
          to_offset: body.to_offset ?? null,
          jsonl_sha256: body.jsonl_sha256 ?? null,
          source_identity: body.source_identity ?? null,
        });
      } catch (error) {
        if (error instanceof RunBlobConflictError) {
          const metadata = error.existing.metadata;
          const existingToOffset =
            typeof metadata.to_offset === "number"
              ? metadata.to_offset
              : body.from_offset === undefined
                ? undefined
                : body.from_offset + error.existing.jsonl_bytes;
          const sameSource =
            body.source_identity !== undefined && metadata.source_identity === body.source_identity;
          const sameCursor =
            body.from_offset !== undefined && metadata.from_offset === body.from_offset;
          if (
            error.existingIsPrefix &&
            sameSource &&
            sameCursor &&
            typeof existingToOffset === "number"
          ) {
            await dependencies.sendCaptured({
              name: "memory/run.captured",
              data: {
                run_id: runId,
                user_id: auth.user_id,
                machine_id: auth.machine_id,
                agent_runtime: body.agent_runtime,
                jsonl_path: error.existing.jsonl_path,
                jsonl_bytes: error.existing.jsonl_bytes,
                jsonl_sha256: error.existing.jsonl_sha256,
                started_at: startedAt,
                parent_run_id: body.parent_run_id ?? undefined,
                conversation_id: body.conversation_id ?? undefined,
                tags,
                from_offset: body.from_offset,
                to_offset: existingToOffset,
                source_identity: body.source_identity,
              },
            });
            return context.json(
              {
                ok: true,
                run_id: runId,
                jsonl_path: error.existing.jsonl_path,
                jsonl_bytes: error.existing.jsonl_bytes,
                jsonl_sha256: error.existing.jsonl_sha256,
                to_offset: existingToOffset,
                status: "accepted_prefix",
              },
              202,
            );
          }
          if (
            body.source_identity !== undefined &&
            body.from_offset !== undefined &&
            (!sameSource || !sameCursor)
          ) {
            releaseSourceCursorClaim(
              sourceCursorClaimDir,
              auth.user_id,
              body.source_identity,
              body.from_offset,
              claim,
            );
          }
          return context.json(
            {
              ok: false,
              error: {
                code: error.code,
                message: "source cursor already exists with different JSONL bytes",
              },
            },
            409,
          );
        }
        throw error;
      }

      if (
        body.source_identity !== undefined &&
        body.from_offset !== undefined &&
        (blob.metadata.source_identity !== body.source_identity ||
          blob.metadata.from_offset !== body.from_offset ||
          blob.metadata.to_offset !== body.from_offset + blob.jsonl_bytes)
      ) {
        releaseSourceCursorClaim(
          sourceCursorClaimDir,
          auth.user_id,
          body.source_identity,
          body.from_offset,
          claim,
        );
        return context.json(
          {
            ok: false,
            error: {
              code: "run_blob_conflict",
              message: "run_id belongs to a different source cursor",
            },
          },
          409,
        );
      }

      if (!claim.created && requestedRunId !== runId && !blob.created) {
        const existingToOffset =
          typeof blob.metadata.to_offset === "number"
            ? blob.metadata.to_offset
            : (body.from_offset as number) + blob.jsonl_bytes;
        await dependencies.sendCaptured({
          name: "memory/run.captured",
          data: {
            run_id: runId,
            user_id: auth.user_id,
            machine_id: auth.machine_id,
            agent_runtime: body.agent_runtime,
            jsonl_path: blob.jsonl_path,
            jsonl_bytes: blob.jsonl_bytes,
            jsonl_sha256: blob.jsonl_sha256,
            started_at: startedAt,
            parent_run_id: body.parent_run_id ?? undefined,
            conversation_id: body.conversation_id ?? undefined,
            tags,
            from_offset: body.from_offset,
            to_offset: existingToOffset,
            source_identity: body.source_identity,
          },
        });
        return context.json(
          {
            ok: true,
            run_id: runId,
            jsonl_path: blob.jsonl_path,
            jsonl_bytes: blob.jsonl_bytes,
            jsonl_sha256: blob.jsonl_sha256,
            to_offset: existingToOffset,
            status: "accepted_prefix",
          },
          202,
        );
      }

      await dependencies.sendCaptured({
        name: "memory/run.captured",
        data: {
          run_id: runId,
          user_id: auth.user_id,
          machine_id: auth.machine_id,
          agent_runtime: body.agent_runtime,
          jsonl_path: blob.jsonl_path,
          jsonl_bytes: blob.jsonl_bytes,
          jsonl_sha256: blob.jsonl_sha256,
          started_at: startedAt,
          parent_run_id: body.parent_run_id ?? undefined,
          conversation_id: body.conversation_id ?? undefined,
          tags,
          from_offset: body.from_offset,
          to_offset: body.to_offset,
          source_identity: body.source_identity,
        },
      });

      return context.json(
        {
          ok: true,
          run_id: runId,
          user_id: auth.user_id,
          machine_id: auth.machine_id,
          jsonl_path: blob.jsonl_path,
          jsonl_bytes: blob.jsonl_bytes,
          jsonl_sha256: blob.jsonl_sha256,
          to_offset: body.to_offset,
          status: "accepted",
          _links: {
            self: `/api/runs/${runId}`,
            search: "/api/runs/search",
          },
        },
        202,
      );
    });
  });
}
