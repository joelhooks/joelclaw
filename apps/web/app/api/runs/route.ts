/**
 * ADR-0243: POST /api/runs — Central ingest endpoint for agent Run capture.
 *
 * v1 slice (Phase 1):
 *   - Auth: dev bearer token (hardcoded allowlist). PDS App Password flow
 *     lands in Phase 3 — see ADR-0243 Rule 6.
 *   - Persist jsonl + metadata to NAS (local dev path via MEMORY_RUN_STORE).
 *   - Fire memory/run.captured; Inngest chunks + embeds + indexes async.
 *   - Return HATEOAS envelope with run_id.
 *
 * Tailnet-only (Rule 7) is enforced at the deployment / ingress layer;
 * this handler does not check the source address.
 */
import { type AgentRuntime, writeRunBlob } from "@joelclaw/memory";
import { type NextRequest, NextResponse } from "next/server";
import { authenticateMemoryRequest } from "@/lib/memory-auth";

const INNGEST_URL = process.env.INNGEST_URL ?? "http://localhost:8288";
const INNGEST_EVENT_KEY =
  process.env.INNGEST_EVENT_KEY ?? "37aa349b89692d657d276a40e0e47a15";

const VALID_RUNTIMES: AgentRuntime[] = [
  "pi",
  "claude-code",
  "codex",
  "loop",
  "workload-stage",
  "gateway",
  "other",
];

interface RunIngestRequest {
  run_id?: string;
  agent_runtime: AgentRuntime;
  started_at?: number;
  parent_run_id?: string;
  conversation_id?: string;
  tags?: string[];
  /** Full jsonl content as a single string. */
  jsonl: string;
}

function newRunId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 26);
}

export async function POST(request: NextRequest) {
  const auth = await authenticateMemoryRequest(request);
  if (!auth) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: "unauthorized", message: "bearer token required" },
      },
      { status: 401 }
    );
  }

  let body: RunIngestRequest;
  try {
    body = (await request.json()) as RunIngestRequest;
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "invalid_json", message: "body must be JSON" } },
      { status: 400 }
    );
  }

  if (!body.jsonl || typeof body.jsonl !== "string") {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "missing_jsonl",
          message: "request body must include `jsonl` as a string",
        },
      },
      { status: 400 }
    );
  }
  if (!VALID_RUNTIMES.includes(body.agent_runtime)) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "invalid_runtime",
          message: `agent_runtime must be one of: ${VALID_RUNTIMES.join(", ")}`,
        },
      },
      { status: 400 }
    );
  }

  const runId = body.run_id ?? newRunId();
  const startedAt = body.started_at ?? Date.now();

  // Persist to authoritative storage (Rule 10). Dev: local dir; prod: NAS.
  const { jsonl_path, jsonl_bytes, jsonl_sha256 } = writeRunBlob(
    auth.user_id,
    runId,
    startedAt,
    body.jsonl,
    {
      run_id: runId,
      user_id: auth.user_id,
      machine_id: auth.machine_id,
      agent_runtime: body.agent_runtime,
      parent_run_id: body.parent_run_id ?? null,
      conversation_id: body.conversation_id ?? null,
      tags: body.tags ?? [],
      started_at: startedAt,
      captured_at: Date.now(),
    }
  );

  // Fire the captured event — Inngest handles chunking + embedding + indexing.
  const inngestRes = await fetch(
    `${INNGEST_URL}/e/${INNGEST_EVENT_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "memory/run.captured",
        data: {
          run_id: runId,
          user_id: auth.user_id,
          machine_id: auth.machine_id,
          agent_runtime: body.agent_runtime,
          jsonl_path,
          jsonl_bytes,
          jsonl_sha256,
          started_at: startedAt,
          parent_run_id: body.parent_run_id,
          conversation_id: body.conversation_id,
          tags: body.tags,
        },
      }),
    }
  );

  if (!inngestRes.ok) {
    const errText = await inngestRes.text();
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "inngest_fire_failed",
          message: `Inngest event fire failed: ${inngestRes.status}`,
          detail: errText.slice(0, 500),
        },
      },
      { status: 502 }
    );
  }

  return NextResponse.json(
    {
      ok: true,
      run_id: runId,
      user_id: auth.user_id,
      machine_id: auth.machine_id,
      jsonl_path,
      jsonl_bytes,
      jsonl_sha256,
      status: "accepted",
      _links: {
        self: `/api/runs/${runId}`,
        jsonl: `/api/runs/${runId}/jsonl`,
        search: "/api/runs/search",
      },
      next_actions: [
        {
          description: "Poll Typesense for ingest completion",
          command: `curl -sS 'http://localhost:8108/collections/run_chunks_dev/documents/search?q=*&query_by=text&filter_by=run_id:=${runId}' -H "X-TYPESENSE-API-KEY: $TYPESENSE_API_KEY"`,
        },
      ],
    },
    { status: 202 }
  );
}
