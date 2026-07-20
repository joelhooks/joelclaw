import { createHash, randomUUID } from "node:crypto";
import {
  type AgentRuntime,
  RunBlobConflictError,
  type RunBlobWriteResult,
} from "@joelclaw/memory";
import type { Context, Hono } from "hono";

const VALID_RUN_RUNTIMES: AgentRuntime[] = [
  "pi",
  "claude-code",
  "codex",
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
  now?: () => number;
  newRunId?: () => string;
};

function parseRunBody(value: unknown): ParsedRunIngestRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as RunIngestRequest;
  if (!body.jsonl || typeof body.jsonl !== "string") return null;
  if (!body.agent_runtime || !VALID_RUN_RUNTIMES.includes(body.agent_runtime)) return null;
  const { from_offset: fromOffset, to_offset: toOffset } = body;
  const segmentFields = [fromOffset, toOffset, body.jsonl_sha256, body.source_identity];
  if (segmentFields.some((field) => field !== undefined)) {
    if (
      !Number.isSafeInteger(fromOffset) ||
      !Number.isSafeInteger(toOffset) ||
      (fromOffset as number) < 0 ||
      (toOffset as number) < (fromOffset as number) ||
      (toOffset as number) - (fromOffset as number) !== Buffer.byteLength(body.jsonl, "utf8") ||
      body.jsonl_sha256 !== createHash("sha256").update(body.jsonl).digest("hex") ||
      typeof body.source_identity !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(body.source_identity)
    ) {
      return null;
    }
  }
  return body as ParsedRunIngestRequest;
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

  app.post("/api/runs", async (context) => {
    const auth = await dependencies.authenticate(context);
    if (!auth) {
      return context.json({ ok: false, error: { code: "unauthorized" } }, 401);
    }

    const body = parseRunBody(await context.req.json().catch(() => null));
    if (!body) {
      return context.json(
        {
          ok: false,
          error: {
            code: "invalid_run_capture",
            message: "Body must include jsonl string and valid agent_runtime",
          },
        },
        400,
      );
    }

    const runId = body.run_id ?? newRunId();
    const startedAt = body.started_at ?? now();
    const tags = Array.isArray(body.tags)
      ? body.tags.filter((tag) => typeof tag === "string")
      : [];
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
          body.source_identity !== undefined &&
          (metadata.source_identity === undefined ||
            metadata.source_identity === body.source_identity);
        const sameCursor =
          body.from_offset !== undefined &&
          (metadata.from_offset === undefined || metadata.from_offset === body.from_offset);
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
        return context.json(
          {
            ok: false,
            error: {
              code: error.code,
              message: "run_id already exists with different JSONL bytes",
            },
          },
          409,
        );
      }
      throw error;
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
}
