import { createHash, randomUUID } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  type AgentRuntime,
  RunBlobConflictError,
  type RunBlobWriteResult,
  runStoreBase,
} from "@joelclaw/memory";
import type { Context, Hono } from "hono";
import { z } from "zod";

const VALID_RUN_RUNTIMES = [
  "pi",
  "claude-code",
  "codex",
  "cursor",
  "grok",
  "loop",
  "workload-stage",
  "gateway",
  "other",
] as const satisfies readonly AgentRuntime[];

const safeOffset = z.number().int().nonnegative().refine(Number.isSafeInteger);
const RunIngestRequestSchema = z.object({
  run_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u).optional(),
  agent_runtime: z.enum(VALID_RUN_RUNTIMES),
  started_at: safeOffset.optional(),
  parent_run_id: z.string().min(1).max(128).nullable().optional(),
  conversation_id: z.string().min(1).max(512).nullable().optional(),
  source_session_id: z.string().min(1).max(512).optional(),
  event_id: z.string().min(1).max(512).optional(),
  tags: z.array(z.string().max(512)).max(128).optional(),
  jsonl: z.string().min(1),
  from_offset: safeOffset.optional(),
  to_offset: safeOffset.optional(),
  jsonl_sha256: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  source_identity: z.string().regex(/^sha256:[0-9a-f]{64}$/u).optional(),
});

export type MemoryIdentity = {
  user_id: string;
  machine_id: string;
  did: string | null;
};

type ParsedRunIngestRequest = z.infer<typeof RunIngestRequestSchema>;

type RunBodyParseResult =
  | { readonly ok: true; readonly body: ParsedRunIngestRequest }
  | { readonly ok: false; readonly code: "invalid-envelope" | "invalid-segment" };

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
    source_session_id?: string;
    event_id?: string;
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

function sourceCursorClaimPath(userId: string, sourceIdentity: string, fromOffset: number): string {
  const key = createHash("sha256")
    .update(JSON.stringify([sourceIdentity, fromOffset]))
    .digest("hex");
  return join(runStoreBase(), userId, ".source-cursors", `${key}.json`);
}

function sourceCursorMigrationReady(userId: string): boolean {
  const markerPath = join(
    runStoreBase(),
    userId,
    ".source-cursors",
    "migration-v1.json",
  );
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
      complete?: unknown;
      schema_version?: unknown;
    };
    return marker.schema_version === 1 && marker.complete === true;
  } catch {
    return false;
  }
}

function readSourceCursorClaim(
  userId: string,
  sourceIdentity: string,
  fromOffset: number,
): SourceCursorClaim | null {
  const path = sourceCursorClaimPath(userId, sourceIdentity, fromOffset);
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as {
      run_id?: unknown;
      started_at?: unknown;
    };
    if (typeof value.run_id !== "string" || !Number.isSafeInteger(value.started_at)) {
      throw new Error("run-capture source claim invalid");
    }
    return {
      run_id: value.run_id,
      started_at: Number(value.started_at),
      created: false,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function claimSourceCursor(
  userId: string,
  sourceIdentity: string,
  fromOffset: number,
  runId: string,
  startedAt: number,
  recovered?: { readonly run_id: string; readonly started_at: number },
): SourceCursorClaim {
  const path = sourceCursorClaimPath(userId, sourceIdentity, fromOffset);
  mkdirSync(dirname(path), { recursive: true });
  const requested = recovered
    ? { ...recovered, created: false }
    : { run_id: runId, started_at: startedAt, created: true };
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(
    temporaryPath,
    JSON.stringify({ run_id: requested.run_id, started_at: requested.started_at }),
  );
  try {
    linkSync(temporaryPath, path);
    return requested;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The claim is authoritative; a failed temp cleanup is harmless.
    }
  }

  let existing: { run_id?: unknown; started_at?: unknown };
  try {
    existing = JSON.parse(readFileSync(path, "utf8")) as {
      run_id?: unknown;
      started_at?: unknown;
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return claimSourceCursor(
        userId,
        sourceIdentity,
        fromOffset,
        runId,
        startedAt,
        recovered,
      );
    }
    unlinkSync(path);
    return claimSourceCursor(
      userId,
      sourceIdentity,
      fromOffset,
      runId,
      startedAt,
      recovered,
    );
  }
  if (typeof existing.run_id !== "string" || !Number.isSafeInteger(existing.started_at)) {
    unlinkSync(path);
    return claimSourceCursor(
      userId,
      sourceIdentity,
      fromOffset,
      runId,
      startedAt,
      recovered,
    );
  }
  return {
    run_id: existing.run_id,
    started_at: existing.started_at as number,
    created: false,
  };
}

function releaseSourceCursorClaim(
  userId: string,
  sourceIdentity: string,
  fromOffset: number,
  claim: SourceCursorClaim,
): void {
  const path = sourceCursorClaimPath(userId, sourceIdentity, fromOffset);
  try {
    const existing = JSON.parse(readFileSync(path, "utf8")) as {
      run_id?: unknown;
      started_at?: unknown;
    };
    if (existing.run_id === claim.run_id && existing.started_at === claim.started_at) {
      unlinkSync(path);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
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

export type RunCaptureFailure = {
  readonly agentRuntime?: AgentRuntime;
  readonly code: "internal_error" | "invalid_run_capture" | "run_blob_conflict" | "unauthorized";
  readonly stage: "authenticate" | "parse" | "persist" | "publish";
};

export function runCaptureFailureTelemetry(failure: RunCaptureFailure) {
  return {
    action: "memory.run.capture.failed",
    component: "run-capture-route",
    error: failure.code,
    level: failure.code === "internal_error" ? "error" : "warn",
    metadata: {
      stage: failure.stage,
      ...(failure.agentRuntime === undefined
        ? {}
        : { agent_runtime: failure.agentRuntime }),
    },
    source: "memory",
    success: false,
  } as const;
}

export type RunCaptureRouteDependencies = {
  authenticate: (context: Context) => Promise<MemoryIdentity | null>;
  writeRunBlob: (
    userId: string,
    runId: string,
    startedAt: number,
    jsonl: string,
    metadata: Record<string, unknown>,
  ) => RunBlobWriteResult;
  sendCaptured: (event: CapturedRunEvent) => Promise<unknown>;
  emitFailure?: (failure: RunCaptureFailure) => Promise<unknown>;
  findSourceCursor?: (
    userId: string,
    sourceIdentity: string,
    fromOffset: number,
  ) =>
    | Promise<{ readonly run_id: string; readonly started_at: number } | null>
    | { readonly run_id: string; readonly started_at: number }
    | null;
  now?: () => number;
  newRunId?: () => string;
};

function parseRunBody(value: unknown): RunBodyParseResult {
  const parsed = RunIngestRequestSchema.safeParse(value);
  if (!parsed.success) return { ok: false, code: "invalid-envelope" };
  const body = parsed.data;
  const { from_offset: fromOffset, to_offset: toOffset } = body;
  const segmentFields = [fromOffset, toOffset, body.jsonl_sha256, body.source_identity];
  if (segmentFields.some((field) => field !== undefined)) {
    if (
      segmentFields.some((field) => field === undefined) ||
      (toOffset as number) < (fromOffset as number) ||
      (toOffset as number) - (fromOffset as number) !== Buffer.byteLength(body.jsonl, "utf8") ||
      body.jsonl_sha256 !== createHash("sha256").update(body.jsonl).digest("hex")
    ) {
      return { ok: false, code: "invalid-segment" };
    }
  }
  return { ok: true, body };
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
  const emitFailure = async (failure: RunCaptureFailure) => {
    if (dependencies.emitFailure === undefined) return;
    await dependencies.emitFailure(failure).catch(() => undefined);
  };
  const publishCaptured = async (event: CapturedRunEvent) => {
    try {
      return await dependencies.sendCaptured(event);
    } catch {
      await emitFailure({
        agentRuntime: event.data.agent_runtime,
        code: "internal_error",
        stage: "publish",
      });
      throw new Error("run-capture publish failed");
    }
  };

  app.post("/api/runs", async (context) => {
    let auth: MemoryIdentity | null;
    try {
      auth = await dependencies.authenticate(context);
    } catch {
      await emitFailure({ code: "internal_error", stage: "authenticate" });
      throw new Error("run-capture authentication failed");
    }
    if (!auth) {
      await emitFailure({ code: "unauthorized", stage: "authenticate" });
      return context.json({ ok: false, error: { code: "unauthorized" } }, 401);
    }

    const parsed = parseRunBody(await context.req.json().catch(() => null));
    if (!parsed.ok) {
      await emitFailure({ code: "invalid_run_capture", stage: "parse" });
      return context.json(
        {
          ok: false,
          error: {
            code: "invalid_run_capture",
            message: "Body does not match the Run capture contract",
          },
        },
        400,
      );
    }
    const body = parsed.body;

    const requestedRunId = body.run_id ?? newRunId();
    const requestedStartedAt = body.started_at ?? now();
    const tags = Array.isArray(body.tags)
      ? body.tags.filter((tag) => typeof tag === "string")
      : [];
    const cursorKey =
      body.source_identity !== undefined && body.from_offset !== undefined
        ? `${auth.user_id}:${body.source_identity}:${body.from_offset}`
        : `legacy:${auth.user_id}:${requestedRunId}`;

    return withSourceCursorLock(cursorKey, async () => {
      let claim: SourceCursorClaim;
      try {
        if (body.source_identity !== undefined && body.from_offset !== undefined) {
          const existing = readSourceCursorClaim(
            auth.user_id,
            body.source_identity,
            body.from_offset,
          );
          const recovered =
            existing === null && dependencies.findSourceCursor !== undefined
              ? await dependencies.findSourceCursor(
                  auth.user_id,
                  body.source_identity,
                  body.from_offset,
                )
              : null;
          if (
            existing === null &&
            dependencies.findSourceCursor !== undefined &&
            recovered === null &&
            !sourceCursorMigrationReady(auth.user_id)
          ) {
            throw new Error("run-capture source cursor migration required");
          }
          claim =
            existing ??
            claimSourceCursor(
              auth.user_id,
              body.source_identity,
              body.from_offset,
              requestedRunId,
              requestedStartedAt,
              recovered ?? undefined,
            );
        } else {
          claim = { run_id: requestedRunId, started_at: requestedStartedAt, created: true };
        }
      } catch {
        await emitFailure({
          agentRuntime: body.agent_runtime,
          code: "internal_error",
          stage: "persist",
        });
        throw new Error("run-capture source claim failed");
      }
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
          source_session_id: body.source_session_id ?? null,
          event_id: body.event_id ?? null,
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
            body.source_identity !== undefined &&
            metadata.source_identity === body.source_identity;
          const sameCursor =
            body.from_offset !== undefined && metadata.from_offset === body.from_offset;
          if (
            error.existingIsPrefix &&
            sameSource &&
            sameCursor &&
            typeof existingToOffset === "number"
          ) {
            await publishCaptured({
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
                source_session_id: body.source_session_id,
                event_id: body.event_id,
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
            claim.created &&
            body.source_identity !== undefined &&
            body.from_offset !== undefined &&
            (!sameSource || !sameCursor)
          ) {
            releaseSourceCursorClaim(
              auth.user_id,
              body.source_identity,
              body.from_offset,
              claim,
            );
          }
          await emitFailure({
            agentRuntime: body.agent_runtime,
            code: "run_blob_conflict",
            stage: "persist",
          });
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
        await emitFailure({
          agentRuntime: body.agent_runtime,
          code: "internal_error",
          stage: "persist",
        });
        throw new Error("run-capture persistence failed");
      }

      if (
        body.source_identity !== undefined &&
        body.from_offset !== undefined &&
        (blob.metadata.source_identity !== body.source_identity ||
          blob.metadata.from_offset !== body.from_offset ||
          blob.metadata.to_offset !== body.from_offset + blob.jsonl_bytes)
      ) {
        if (claim.created) {
          releaseSourceCursorClaim(auth.user_id, body.source_identity, body.from_offset, claim);
        }
        await emitFailure({
          agentRuntime: body.agent_runtime,
          code: "run_blob_conflict",
          stage: "persist",
        });
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
        await publishCaptured({
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
            source_session_id: body.source_session_id,
            event_id: body.event_id,
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

      await publishCaptured({
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
          source_session_id: body.source_session_id,
          event_id: body.event_id,
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
