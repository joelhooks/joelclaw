import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type OtelLevel = "info" | "warn" | "error";

const SOURCE = process.env.GATEWAY_ROLE || "interactive";
const CHANNEL = process.env.GATEWAY_ROLE || process.env.JOELCLAW_CHANNEL || "interactive";
const JOELCLAW_BIN = process.env.JOELCLAW_BIN || "joelclaw";

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return fallback;
}

const RECALL_TIMEOUT_MS = parsePositiveInt(process.env.JOELCLAW_MEMORY_RECALL_TIMEOUT_MS, 15_000);
const RECALL_LIMIT = parsePositiveInt(process.env.JOELCLAW_MEMORY_RECALL_LIMIT, 5);
const RECALL_QUERY =
  process.env.JOELCLAW_MEMORY_RECALL_QUERY ||
  "recent decisions, active work, unresolved failures, and operational context";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function getPath(root: unknown, path: string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[key];
  }
  return current;
}

function asCount(value: unknown): number | null {
  if (Array.isArray(value)) return value.length;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function extractResultCount(rawOutput: string): number {
  try {
    const parsed = JSON.parse(rawOutput) as unknown;

    const countCandidates: Array<number | null> = [
      asCount(getPath(parsed, ["result", "hits"])),
      asCount(getPath(parsed, ["result", "result", "hits"])),
      asCount(getPath(parsed, ["envelope", "result", "hits"])),
      asCount(getPath(parsed, ["payload", "hits"])),
      asCount(getPath(parsed, ["hits"])),
      asCount(getPath(parsed, ["result", "count"])),
      asCount(getPath(parsed, ["envelope", "result", "count"])),
      asCount(getPath(parsed, ["payload", "count"])),
      asCount(getPath(parsed, ["count"])),
    ];

    for (const candidate of countCandidates) {
      if (candidate != null) return candidate;
    }

    return 0;
  } catch {
    return 0;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function emitOtel(
  action: string,
  metadata: Record<string, unknown>,
  options: { level?: OtelLevel; success?: boolean } = {},
): void {
  const event = {
    id: randomUUID(),
    timestamp: Date.now(),
    level: options.level ?? "info",
    source: SOURCE,
    component: "memory-enforcer",
    action,
    success: options.success ?? true,
    metadata,
  };
  const args = [
    "otel", "emit", action,
    "--source", event.source,
    "--component", event.component,
    "--level", event.level,
    "--json",
  ];
  args.push("--success", event.success ? "true" : "false");
  if (Object.keys(metadata).length > 0) {
    args.push("--metadata", JSON.stringify(metadata));
  }
  const child = spawn(JOELCLAW_BIN, args, {
    stdio: ["ignore", "ignore", "ignore"],
    shell: false,
  });
  child.on("error", () => {});
}

function runRecallCommand(): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ["recall", RECALL_QUERY, "--limit", String(RECALL_LIMIT), "--json"];
    const child = spawn(JOELCLAW_BIN, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | undefined;

    const settle = (cb: () => void): void => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      cb();
    };

    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      settle(() => reject(error));
    });

    child.on("close", (code, signal) => {
      if (code === 0) {
        settle(() => resolve(stdout));
        return;
      }

      const details = [
        `exit=${code ?? "null"}`,
        signal ? `signal=${signal}` : null,
        stderr.trim().length > 0 ? `stderr=${stderr.trim()}` : null,
      ]
        .filter(Boolean)
        .join(", ");

      settle(() => reject(new Error(`joelclaw recall failed (${details})`)));
    });

    timeoutHandle = setTimeout(() => {
      child.kill("SIGTERM");
      settle(() => reject(new Error(`joelclaw recall timed out after ${RECALL_TIMEOUT_MS}ms`)));
    }, RECALL_TIMEOUT_MS);
  });
}

// Typesense direct access removed — system_knowledge queries go through `joelclaw knowledge search` CLI

async function querySystemKnowledge(query: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(JOELCLAW_BIN, ["knowledge", "search", query, "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    let stdout = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) { settled = true; child.kill(); resolve(""); }
    }, 15_000);

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        const parsed = JSON.parse(stdout);
        if (!parsed.ok || !parsed.result?.hits?.length) { resolve(""); return; }
        const formatted = parsed.result.hits
          .map((r: { type?: string; title?: string; snippet?: string }) =>
            `[${r.type}] ${r.title}: ${String(r.snippet).slice(0, 500)}`)
          .join("\n\n");
        resolve(formatted);
      } catch { resolve(""); }
    });
    child.on("error", () => { if (!settled) { settled = true; clearTimeout(timeout); resolve(""); } });
  });
}

async function seedSystemKnowledge(
  sessionId: string | null,
  trigger: "before_agent_start" | "session_start" = "before_agent_start",
): Promise<void> {
  const startedAt = Date.now();

  emitOtel("system_knowledge.retrieval.started", {
    session_id: sessionId,
    channel: CHANNEL,
    trigger,
  });

  try {
    const result = await querySystemKnowledge(RECALL_QUERY);
    emitOtel("system_knowledge.retrieval.completed", {
      session_id: sessionId,
      channel: CHANNEL,
      trigger,
      result_length: result.length,
      has_results: result.length > 0,
      latency_ms: Date.now() - startedAt,
    });
  } catch (error) {
    emitOtel(
      "system_knowledge.retrieval.failed",
      {
        session_id: sessionId,
        channel: CHANNEL,
        trigger,
        error: errorMessage(error),
        latency_ms: Date.now() - startedAt,
      },
      { level: "warn", success: false },
    );
  }
}

function seedRecall(sessionId: string | null): void {
  const startedAt = Date.now();

  emitOtel("memory.recall.started", {
    session_id: sessionId,
    channel: CHANNEL,
    query: RECALL_QUERY,
    timeout_ms: RECALL_TIMEOUT_MS,
  });

  void runRecallCommand()
    .then((output) => {
      emitOtel("memory.recall.completed", {
        session_id: sessionId,
        channel: CHANNEL,
        query: RECALL_QUERY,
        result_count: extractResultCount(output),
        latency_ms: Date.now() - startedAt,
      });
    })
    .catch((error) => {
      emitOtel(
        "memory.recall.failed",
        {
          session_id: sessionId,
          channel: CHANNEL,
          query: RECALL_QUERY,
          latency_ms: Date.now() - startedAt,
          error: errorMessage(error),
        },
        {
          level: "warn",
          success: false,
        },
      );

      console.warn(`[memory-enforcer] recall seed failed: ${errorMessage(error)}`);
    });
}

function requestObserve(sessionId: string | null): void {
  const data = {
    session_id: sessionId,
    trigger: "session_shutdown",
    channel: CHANNEL,
  };

  emitOtel("memory.observe.requested", data);

  void (async () => {
    try {
      const response = await fetch("http://localhost:8288/e/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "memory/observe.requested",
          data,
        }),
        signal: AbortSignal.timeout(3_000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (error) {
      emitOtel(
        "memory.observe.failed",
        {
          ...data,
          error: errorMessage(error),
        },
        {
          level: "warn",
          success: false,
        },
      );

      console.warn(`[memory-enforcer] observe request failed: ${errorMessage(error)}`);
    }
  })();
}

const MEMORY_NUDGE =
  "\n\n## Memory — Write Observations (NON-OPTIONAL)\n" +
  "When you learn something non-obvious, discover a pattern, hit a gotcha, or solve a hard problem — " +
  "**write it to memory immediately**. Do not wait until session end.\n\n" +
  "```bash\n" +
  'joelclaw memory write "what you learned" --category ops --tags relevant,tags\n' +
  "```\n\n" +
  "Categories: `ops` · `rules` · `arch` · `projects` · `prefs` · `people` · `memory`\n\n" +
  "Good observations: API behaviour, CLI quirks, operational SOPs, per-project facts, architectural constraints, " +
  "debug insights, things that would save future-you 30 minutes.\n" +
  "Skip: transcript noise, raw tool output, things already in a skill or ADR.";

export default function memoryEnforcer(pi: ExtensionAPI): void {
  let currentSessionId: string | null = null;

  // ── Per-turn: inject memory-write pressure into system prompt ──
  pi.on("before_agent_start", async (event: { systemPrompt?: string }) => {
    return {
      systemPrompt: (event.systemPrompt ?? "") + MEMORY_NUDGE,
    };
  });

  pi.on("session_start", (_event: unknown, ctx: { sessionManager?: { getSessionId?: () => string | null | undefined } }) => {
    try {
      currentSessionId = ctx.sessionManager?.getSessionId?.() ?? null;
    } catch {
      currentSessionId = null;
    }

    const sessionId = currentSessionId;
    setTimeout(() => seedRecall(sessionId), 0);
  });

  pi.on(
    "before_agent_start",
    async (_event: unknown, ctx: { sessionManager?: { getSessionId?: () => string | null | undefined } }) => {
      let sessionId = currentSessionId;
      try {
        sessionId = ctx.sessionManager?.getSessionId?.() ?? currentSessionId;
      } catch {
        sessionId = currentSessionId;
      }

      currentSessionId = sessionId;
      await seedSystemKnowledge(sessionId, "before_agent_start");
    },
  );

  pi.on("session_shutdown", (...args: unknown[]) => {
    let sessionIdFromCtx: string | null = null;

    try {
      const ctx = args[1] as
        | {
            sessionManager?: {
              getSessionId?: () => string | null | undefined;
            };
          }
        | undefined;

      sessionIdFromCtx = ctx?.sessionManager?.getSessionId?.() ?? null;
    } catch {
      sessionIdFromCtx = null;
    }

    requestObserve(sessionIdFromCtx ?? currentSessionId);
  });
}
