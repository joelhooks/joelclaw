import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type OtelLevel = "info" | "warn" | "error";

const SOURCE = process.env.GATEWAY_ROLE || "interactive";
const CHANNEL = process.env.GATEWAY_ROLE || process.env.JOELCLAW_CHANNEL || "interactive";
const JOELCLAW_BIN = process.env.JOELCLAW_BIN || "joelclaw";
const HOME = os.homedir();
const JOELCLAW_REPO = path.join(HOME, "Code", "joelhooks", "joelclaw");

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return fallback;
}

function readSafe(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readEnvVarFromFiles(name: string, filePaths: string[]): string {
  const pattern = new RegExp(`^(?:export\\s+)?${escapeRegExp(name)}=(.+)$`, "m");

  for (const filePath of filePaths) {
    const content = readSafe(filePath);
    if (!content) continue;

    const match = content.match(pattern);
    if (!match) continue;

    const raw = match[1]?.trim() ?? "";
    if (!raw) continue;

    const unquoted = raw.replace(/^"|"$/g, "").replace(/^'|'$/g, "");
    if (unquoted.length > 0) return unquoted;
  }

  return "";
}

function resolveInngestEventUrl(): string | null {
  const envPaths = [
    path.join(HOME, ".config", "inngest", "env"),
    path.join(HOME, ".config", "system-bus.env"),
    path.join(JOELCLAW_REPO, "packages", "system-bus", ".env"),
    "/Users/Shared/joelclaw/etc/inngest/inngest.env",
  ];

  const eventKey =
    process.env.INNGEST_EVENT_KEY?.trim() ||
    readEnvVarFromFiles("INNGEST_EVENT_KEY", envPaths);

  if (!eventKey) return null;

  const baseUrl =
    process.env.INNGEST_BASE_URL?.trim() ||
    process.env.INNGEST_URL?.trim() ||
    readEnvVarFromFiles("INNGEST_BASE_URL", envPaths) ||
    readEnvVarFromFiles("INNGEST_URL", envPaths) ||
    "http://localhost:8288";

  return `${baseUrl.replace(/\/$/u, "")}/e/${eventKey}`;
}

const RECALL_TIMEOUT_MS = parsePositiveInt(process.env.JOELCLAW_MEMORY_RECALL_TIMEOUT_MS, 15_000);
const RECALL_INJECTION_WAIT_MS = parsePositiveInt(process.env.JOELCLAW_MEMORY_RECALL_INJECTION_WAIT_MS, 250);
const RECALL_LIMIT = parsePositiveInt(process.env.JOELCLAW_MEMORY_RECALL_LIMIT, 5);
const DEFAULT_RECALL_QUERY = "recent decisions, active work, unresolved failures, and operational context";
const GATEWAY_RECALL_QUERY = "gateway daemon telegram redis session routing compaction";

function getRecallQuery(): string {
  const override = process.env.JOELCLAW_MEMORY_RECALL_QUERY?.trim();
  if (override) return override;
  if (CHANNEL === "central" || CHANNEL === "gateway") return GATEWAY_RECALL_QUERY;
  return DEFAULT_RECALL_QUERY;
}

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

function isUsefulRecallObservation(observation: string): boolean {
  const trimmed = observation.trim();
  if (!trimmed) return false;

  const junkPatterns = [
    /^Acknowledged\. Let me pause and summarize/iu,
    /## Plan Summary/iu,
    /\bShould I:\b/iu,
  ];

  return !junkPatterns.some((pattern) => pattern.test(trimmed));
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
    const recallQuery = getRecallQuery();
    const args = ["recall", recallQuery, "--limit", String(RECALL_LIMIT), "--json"];
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

async function buildSystemKnowledgeMessage(
  sessionId: string | null,
  trigger: "before_agent_start" | "session_start" = "before_agent_start",
): Promise<HiddenCustomMessage | null> {
  const startedAt = Date.now();
  const recallQuery = getRecallQuery();

  emitOtel("system_knowledge.retrieval.started", {
    session_id: sessionId,
    channel: CHANNEL,
    trigger,
    query: recallQuery,
  });

  try {
    const result = await querySystemKnowledge(recallQuery);
    emitOtel("system_knowledge.retrieval.completed", {
      session_id: sessionId,
      channel: CHANNEL,
      trigger,
      query: recallQuery,
      result_length: result.length,
      has_results: result.length > 0,
      latency_ms: Date.now() - startedAt,
    });

    // ADR-0204: inject system knowledge ONCE per session (not every turn!)
    // before_agent_start fires every turn — without this guard, each turn
    // adds a new hidden message that accumulates and causes compaction cascades.
    if (result.length === 0 || knowledgeInjected) return null;

    knowledgeInjected = true;
    emitOtel("system_knowledge.injected", {
      session_id: sessionId,
      channel: CHANNEL,
      result_length: result.length,
    });

    return {
      customType: "system-knowledge",
      content: `## System Knowledge (auto-retrieved)\n${result}`,
      display: false,
    };
  } catch (error) {
    emitOtel(
      "system_knowledge.retrieval.failed",
      {
        session_id: sessionId,
        channel: CHANNEL,
        trigger,
        query: recallQuery,
        error: errorMessage(error),
        latency_ms: Date.now() - startedAt,
      },
      { level: "warn", success: false },
    );
    return null;
  }
}

/** Parse recall JSON output into formatted observation lines. */
function formatRecallHits(rawOutput: string, maxHits = 5): string[] {
  try {
    const parsed = JSON.parse(rawOutput) as Record<string, unknown>;
    const result = parsed.result as Record<string, unknown> | undefined;
    const hits = Array.isArray(result?.hits) ? result.hits : [];
    if (hits.length === 0) return [];

    const lines: string[] = [];
    for (const hit of hits.slice(0, maxHits)) {
      if (!hit || typeof hit !== "object") continue;
      const h = hit as Record<string, unknown>;
      const obs = typeof h.observation === "string" ? h.observation.trim() : "";
      if (!obs || !isUsefulRecallObservation(obs)) continue;
      const catId = typeof h.categoryId === "string" ? h.categoryId.replace("jc:", "") : "memory";
      const cat = catId.split(":").pop() ?? "memory";
      lines.push(`- [${cat}] ${obs.slice(0, 250)}`);
    }
    return lines;
  } catch {
    return [];
  }
}

/** Parse system knowledge JSON output into formatted lines. */
function formatKnowledgeHits(rawOutput: string, maxHits = 3): string[] {
  try {
    const parsed = JSON.parse(rawOutput) as Record<string, unknown>;
    const result = parsed.result as Record<string, unknown> | undefined;
    const hits = Array.isArray(result?.hits) ? result.hits : [];
    if (hits.length === 0) return [];

    const lines: string[] = [];
    for (const hit of hits.slice(0, maxHits)) {
      if (!hit || typeof hit !== "object") continue;
      const h = hit as Record<string, unknown>;
      const title = typeof h.title === "string" ? h.title.trim() : "";
      const type = typeof h.type === "string" ? h.type : "doc";
      const snippet = typeof h.snippet === "string" ? h.snippet.trim().slice(0, 200) : "";
      if (!title && !snippet) continue;
      lines.push(`- [${type}] ${title}${snippet ? `: ${snippet}` : ""}`);
    }
    return lines;
  } catch {
    return [];
  }
}

type HiddenCustomMessage = {
  customType: string;
  content: string;
  display: false;
};

async function buildRecallMessage(sessionId: string | null): Promise<HiddenCustomMessage | null> {
  const startedAt = Date.now();
  const recallQuery = getRecallQuery();

  emitOtel("memory.recall.started", {
    session_id: sessionId,
    channel: CHANNEL,
    query: recallQuery,
    timeout_ms: RECALL_TIMEOUT_MS,
  });

  try {
    const output = await runRecallCommand();
    const resultCount = extractResultCount(output);
    const hitLines = formatRecallHits(output, RECALL_LIMIT);

    emitOtel("memory.recall.completed", {
      session_id: sessionId,
      channel: CHANNEL,
      query: recallQuery,
      result_count: resultCount,
      injected_count: hitLines.length,
      latency_ms: Date.now() - startedAt,
    });

    // ADR-0204: inject recall results ONCE per session (not every turn)
    if (hitLines.length === 0 || recallInjected) return null;

    recallInjected = true;
    const content = [
      "## Relevant Memory (auto-retrieved)",
      ...hitLines,
    ].join("\n");

    emitOtel("memory.recall.injected", {
      session_id: sessionId,
      channel: CHANNEL,
      hit_count: hitLines.length,
    });

    return { customType: "memory-recall", content, display: false };
  } catch (error) {
    emitOtel(
      "memory.recall.failed",
      {
        session_id: sessionId,
        channel: CHANNEL,
        query: recallQuery,
        latency_ms: Date.now() - startedAt,
        error: errorMessage(error),
      },
      {
        level: "warn",
        success: false,
      },
    );

    console.warn(`[memory-enforcer] recall seed failed: ${errorMessage(error)}`);
    return null;
  }
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
      const eventUrl = resolveInngestEventUrl();
      if (!eventUrl) {
        console.warn("[memory-enforcer] observe request skipped: missing INNGEST_EVENT_KEY");
        return;
      }

      const response = await fetch(eventUrl, {
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

// Module-level injection guards — reset per session in session_start.
// These must be module-scope so buildRecallMessage() and buildSystemKnowledgeMessage() can access them.
let recallInjected = false;
let recallMessageDelivered = false;
let knowledgeInjected = false;

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
  let recallMessage: HiddenCustomMessage | null | undefined;
  let recallMessagePromise: Promise<HiddenCustomMessage | null> | null = null;

  async function getReadyRecallMessage(): Promise<HiddenCustomMessage | null> {
    if (recallMessageDelivered) return null;
    if (recallMessage !== undefined) {
      if (!recallMessage) return null;
      recallMessageDelivered = true;
      return recallMessage;
    }

    if (!recallMessagePromise) return null;

    const maybeMessage = await Promise.race([
      recallMessagePromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), RECALL_INJECTION_WAIT_MS)),
    ]);

    if (!maybeMessage || recallMessageDelivered) return null;
    recallMessageDelivered = true;
    return maybeMessage;
  }

  // ── Per-turn: inject memory-write pressure into system prompt ──
  pi.on(
    "before_agent_start",
    async (
      event: { systemPrompt?: string },
      ctx: { sessionManager?: { getSessionId?: () => string | null | undefined } },
    ) => {
      let sessionId = currentSessionId;
      try {
        sessionId = ctx.sessionManager?.getSessionId?.() ?? currentSessionId;
      } catch {
        sessionId = currentSessionId;
      }

      currentSessionId = sessionId;
      const message = await getReadyRecallMessage();

      return {
        systemPrompt: (event.systemPrompt ?? "") + MEMORY_NUDGE,
        ...(message ? { message } : {}),
      };
    },
  );

  pi.on("session_start", (_event: unknown, ctx: { sessionManager?: { getSessionId?: () => string | null | undefined } }) => {
    try {
      currentSessionId = ctx.sessionManager?.getSessionId?.() ?? null;
    } catch {
      currentSessionId = null;
    }

    recallInjected = false;
    recallMessageDelivered = false;
    knowledgeInjected = false;
    recallMessage = undefined;
    recallMessagePromise = buildRecallMessage(currentSessionId).then((message) => {
      recallMessage = message;
      return message;
    });
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
      const message = await buildSystemKnowledgeMessage(sessionId, "before_agent_start");
      return message ? { message } : undefined;
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
