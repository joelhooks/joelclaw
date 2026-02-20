/**
 * VIP email workflow.
 *
 * Uses Opus for deep analysis and follow-through for high-signal senders.
 */

import { spawnSync } from "node:child_process";
import { inngest } from "../client";
import { parseClaudeOutput, pushGatewayEvent } from "./agent-loop/utils";
import { TodoistTaskAdapter } from "../../tasks";
import { isVipSender } from "./vip-utils";

const FRONT_API = "https://api2.frontapp.com";
const VIP_MODEL = process.env.JOELCLAW_VIP_EMAIL_MODEL ?? "anthropic/claude-opus-4-1";
const TRIAGE_MODEL = process.env.JOELCLAW_VIP_TRIAGE_MODEL ?? "anthropic/claude-sonnet-4-6";
const ENABLE_GITHUB_SEARCH = (process.env.JOELCLAW_VIP_ENABLE_GITHUB_SEARCH ?? "0") === "1";
const ENABLE_OPUS_ESCALATION = (process.env.JOELCLAW_VIP_ENABLE_OPUS_ESCALATION ?? "1") === "1";
const TOTAL_BUDGET_MS = Number(process.env.JOELCLAW_VIP_TOTAL_BUDGET_MS ?? "10000");
const FRONT_TIMEOUT_MS = Number(process.env.JOELCLAW_VIP_FRONT_TIMEOUT_MS ?? "2000");
const GRANOLA_TIMEOUT_MS = Number(process.env.JOELCLAW_VIP_GRANOLA_TIMEOUT_MS ?? "2500");
const QDRANT_TIMEOUT_MS = Number(process.env.JOELCLAW_VIP_QDRANT_TIMEOUT_MS ?? "3500");
const GITHUB_TIMEOUT_MS = Number(process.env.JOELCLAW_VIP_GITHUB_TIMEOUT_MS ?? "1500");
const TRIAGE_TIMEOUT_MS = Number(process.env.JOELCLAW_VIP_TRIAGE_TIMEOUT_MS ?? "4500");
const OPUS_TIMEOUT_MS = Number(process.env.JOELCLAW_VIP_OPUS_TIMEOUT_MS ?? "7000");
const MIN_OPUS_TIME_REMAINING_MS = Number(process.env.JOELCLAW_VIP_MIN_OPUS_REMAINING_MS ?? "7500");
const GRANOLA_RANGES = (process.env.JOELCLAW_VIP_GRANOLA_RANGES ?? "year")
  .split(",")
  .map((range) => range.trim())
  .filter(Boolean);

const VIP_SYSTEM_PROMPT = `You are a relationship intelligence analyst for Joel Hooks.

Goal: produce the highest-value action plan for a VIP email.

Rules:
- Reason deeply from provided context.
- Prioritize concrete next actions with clear owners and timing.
- Generate comprehensive todos.
- Explicitly list information the agent cannot access or verify.
- Never fabricate facts.
- If a source lookup failed, treat it as an access gap.

Respond ONLY with valid JSON:
{
  "executive_summary": "string",
  "interaction_signals": ["string"],
  "entity_investigation": [{ "entity": "string", "type": "person|company|project|property|other", "notes": "string", "confidence": "high|medium|low" }],
  "todos": [{ "title": "string", "description": "string", "priority": 1, "due": "optional natural language due" }],
  "missing_information": [{ "item": "string", "why_missing": "string", "how_to_get_it": "string" }],
  "questions_for_human": ["string"]
}`;

const VIP_TRIAGE_PROMPT = `You are a fast triage analyst for VIP email processing.

Return only valid JSON with this exact shape:
{
  "needs_opus": true|false,
  "complexity": "low|medium|high",
  "reason": "short reason",
  "analysis": {
    "executive_summary": "string",
    "interaction_signals": ["string"],
    "entity_investigation": [{ "entity": "string", "type": "person|company|project|property|other", "notes": "string", "confidence": "high|medium|low" }],
    "todos": [{ "title": "string", "description": "string", "priority": 1, "due": "optional natural language due" }],
    "missing_information": [{ "item": "string", "why_missing": "string", "how_to_get_it": "string" }],
    "questions_for_human": ["string"]
  }
}

Set needs_opus=true only when high ambiguity, high risk, or executive-sensitive decisions require deep reasoning.`;

type GranolaMeeting = {
  id: string;
  title: string;
  date?: string;
  participants?: string[];
};

type GitHubRepo = {
  name?: string;
  description?: string;
  url?: string;
  updatedAt?: string;
  stargazersCount?: number;
};

type MissingInfo = {
  item: string;
  why_missing: string;
  how_to_get_it: string;
};

type VipTodo = {
  title: string;
  description: string;
  priority?: number;
  due?: string;
};

type VipAnalysis = {
  executive_summary: string;
  interaction_signals: string[];
  entity_investigation: Array<{ entity: string; type: string; notes: string; confidence: string }>;
  todos: VipTodo[];
  missing_information: MissingInfo[];
  questions_for_human: string[];
};

function toLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseJsonOutput<T>(command: string, args: string[], timeoutMs = 30_000): { ok: boolean; data?: T; error?: string } {
  const proc = spawnSync(command, args, {
    encoding: "utf-8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TERM: "dumb" },
  });

  const stdout = (proc.stdout ?? "").trim();
  const stderr = (proc.stderr ?? "").trim();

  if (proc.status !== 0) {
    return { ok: false, error: stderr || stdout || `exit ${proc.status ?? "unknown"}` };
  }

  if (!stdout) {
    return { ok: false, error: "no output" };
  }

  try {
    return { ok: true, data: JSON.parse(stdout) as T };
  } catch {
    return { ok: false, error: `invalid JSON output: ${stdout.slice(0, 200)}` };
  }
}

function normalizePriority(priority?: number): 1 | 2 | 3 | 4 {
  if (priority === 4 || priority === 3 || priority === 2 || priority === 1) return priority;
  return 2;
}

function readFrontToken(): string {
  return process.env.FRONT_API_TOKEN ?? "";
}

async function fetchJsonWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFrontContext(conversationId: string): Promise<{ summary: Record<string, unknown>; recentMessages: string[] } | null> {
  const token = readFrontToken();
  if (!token || !conversationId) return null;

  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };

  try {
    const convoRes = await fetchJsonWithTimeout(
      `${FRONT_API}/conversations/${conversationId}`,
      { headers },
      FRONT_TIMEOUT_MS
    );
    if (!convoRes.ok) return null;
    const convo = (await convoRes.json()) as Record<string, unknown>;

    const msgRes = await fetchJsonWithTimeout(
      `${FRONT_API}/conversations/${conversationId}/messages?limit=8`,
      { headers },
      FRONT_TIMEOUT_MS
    );

    let recentMessages: string[] = [];
    if (msgRes.ok) {
      const msgBody = (await msgRes.json()) as Record<string, unknown>;
      const results = Array.isArray(msgBody._results) ? msgBody._results : [];
      recentMessages = results
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
        .map((item) => {
          const author = (item.author ?? {}) as Record<string, unknown>;
          const who = String(author.username ?? author.email ?? "unknown");
          const text = String(item.text ?? item.blurb ?? "").replace(/\s+/g, " ").trim();
          return `${who}: ${text}`.slice(0, 500);
        })
        .filter(Boolean);
    }

    return {
      summary: {
        subject: String(convo.subject ?? ""),
        status: String(convo.status ?? ""),
        tags: Array.isArray(convo.tags) ? convo.tags : [],
      },
      recentMessages,
    };
  } catch {
    return null;
  }
}

function parseGranolaMeetingsResponse(data: unknown): GranolaMeeting[] {
  if (!data || typeof data !== "object") return [];
  const body = data as Record<string, unknown>;
  const result = (body.result ?? {}) as Record<string, unknown>;
  const meetings = Array.isArray(result.meetings)
    ? result.meetings
    : Array.isArray(body.result)
      ? body.result
      : [];

  return meetings
    .filter((meeting): meeting is Record<string, unknown> => Boolean(meeting) && typeof meeting === "object")
    .map((meeting) => ({
      id: String(meeting.id ?? ""),
      title: String(meeting.title ?? "Untitled"),
      date: typeof meeting.date === "string" ? meeting.date : undefined,
      participants: Array.isArray(meeting.participants)
        ? meeting.participants.filter((p): p is string => typeof p === "string")
        : undefined,
    }))
    .filter((meeting) => Boolean(meeting.id));
}

function tokenizeSubject(subject: string): string[] {
  return subject
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4)
    .slice(0, 8);
}

function findRelatedMeetings(meetings: GranolaMeeting[], senderName: string, subject: string): GranolaMeeting[] {
  const senderTokens = senderName.toLowerCase().split(/\s+/g).filter((token) => token.length >= 3);
  const subjectTokens = tokenizeSubject(subject);

  return meetings.filter((meeting) => {
    const haystack = `${meeting.title} ${(meeting.participants ?? []).join(" ")}`.toLowerCase();
    const senderMatch = senderTokens.some((token) => haystack.includes(token));
    const subjectMatch = subjectTokens.some((token) => haystack.includes(token));
    return senderMatch || subjectMatch;
  });
}

function parseVipAnalysis(raw: string): VipAnalysis {
  const parsed = parseClaudeOutput(raw);
  if (!parsed || typeof parsed !== "object") {
    return {
      executive_summary: "Unable to parse VIP analysis output.",
      interaction_signals: [],
      entity_investigation: [],
      todos: [],
      missing_information: [],
      questions_for_human: [],
    };
  }

  const data = parsed as Record<string, unknown>;

  const todos = Array.isArray(data.todos)
    ? data.todos
        .filter((todo): todo is Record<string, unknown> => Boolean(todo) && typeof todo === "object")
        .map((todo) => ({
          title: String(todo.title ?? "").trim(),
          description: String(todo.description ?? "").trim(),
          priority: Number(todo.priority ?? 2),
          due: typeof todo.due === "string" ? todo.due : undefined,
        }))
        .filter((todo) => Boolean(todo.title))
    : [];

  const missing = Array.isArray(data.missing_information)
    ? data.missing_information
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
        .map((item) => ({
          item: String(item.item ?? "").trim(),
          why_missing: String(item.why_missing ?? "").trim(),
          how_to_get_it: String(item.how_to_get_it ?? "").trim(),
        }))
        .filter((item) => Boolean(item.item))
    : [];

  const entities = Array.isArray(data.entity_investigation)
    ? data.entity_investigation
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
        .map((item) => ({
          entity: String(item.entity ?? "").trim(),
          type: String(item.type ?? "other").trim(),
          notes: String(item.notes ?? "").trim(),
          confidence: String(item.confidence ?? "medium").trim(),
        }))
        .filter((item) => Boolean(item.entity))
    : [];

  const signals = Array.isArray(data.interaction_signals)
    ? data.interaction_signals.map((item) => String(item)).filter(Boolean)
    : [];

  const questions = Array.isArray(data.questions_for_human)
    ? data.questions_for_human.map((item) => String(item)).filter(Boolean)
    : [];

  return {
    executive_summary: String(data.executive_summary ?? "VIP analysis generated."),
    interaction_signals: signals,
    entity_investigation: entities,
    todos,
    missing_information: missing,
    questions_for_human: questions,
  };
}

type TriageDecision = {
  needs_opus: boolean;
  complexity: string;
  reason: string;
  analysis: VipAnalysis;
};

function runModelAnalysis(model: string, systemPrompt: string, prompt: string, timeoutMs: number): { analysis: VipAnalysis; error?: string } {
  const proc = spawnSync(
    "pi",
    ["-p", "--no-session", "--no-extensions", "--model", model, "--system-prompt", systemPrompt, prompt],
    {
      encoding: "utf-8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, TERM: "dumb" },
    }
  );

  const stdout = (proc.stdout ?? "").trim();
  const stderr = (proc.stderr ?? "").trim();

  if (proc.status !== 0 && !stdout) {
    return {
      analysis: parseVipAnalysis(""),
      error: `model failure (${proc.status ?? "unknown"}): ${stderr.slice(0, 250)}`,
    };
  }

  return { analysis: parseVipAnalysis(stdout), error: proc.status !== 0 ? stderr.slice(0, 250) : undefined };
}

function parseTriageDecision(raw: string): TriageDecision {
  const parsed = parseClaudeOutput(raw);
  if (!parsed || typeof parsed !== "object") {
    return {
      needs_opus: false,
      complexity: "medium",
      reason: "triage parse failed",
      analysis: parseVipAnalysis(raw),
    };
  }

  const data = parsed as Record<string, unknown>;
  const analysis = parseVipAnalysis(JSON.stringify(data.analysis ?? {}));

  return {
    needs_opus: Boolean(data.needs_opus),
    complexity: String(data.complexity ?? "medium"),
    reason: String(data.reason ?? "no reason provided"),
    analysis,
  };
}

function buildAnalysisPrompt(input: {
  senderDisplay: string;
  subject: string;
  conversationId: string;
  preview: string;
  frontContext: { summary: Record<string, unknown>; recentMessages: string[] } | null;
  granolaMeetings: GranolaMeeting[];
  memoryContext: string[];
  githubRepos: GitHubRepo[];
  accessGaps: MissingInfo[];
}): string {
  const relatedMeetingLines = input.granolaMeetings.map((meeting) => {
    const when = meeting.date ? ` (${meeting.date})` : "";
    return `- ${meeting.title}${when} [${meeting.id}]`;
  });

  const repoLines = input.githubRepos.map((repo) => {
    const name = repo.name ?? "unknown";
    const description = repo.description ?? "";
    const url = repo.url ?? "";
    return `- ${name}: ${description} ${url}`.trim();
  });

  return [
    `VIP sender: ${input.senderDisplay}`,
    `Subject: ${input.subject}`,
    `Conversation ID: ${input.conversationId}`,
    `Preview: ${input.preview}`,
    "",
    "Front conversation summary:",
    JSON.stringify(input.frontContext?.summary ?? {}, null, 2),
    "",
    "Recent Front messages:",
    ...(input.frontContext?.recentMessages ?? []),
    "",
    "Related Granola meetings:",
    ...(relatedMeetingLines.length > 0 ? relatedMeetingLines : ["- none found"]),
    "",
    "Memory recall excerpts:",
    ...(input.memoryContext.length > 0 ? input.memoryContext : ["- none found"]),
    "",
    "GitHub repositories:",
    ...(repoLines.length > 0 ? repoLines : ["- none found"]),
    "",
    "Access gaps detected before analysis:",
    ...(input.accessGaps.length > 0
      ? input.accessGaps.map((gap) => `- ${gap.item}: ${gap.why_missing}. How to get: ${gap.how_to_get_it}`)
      : ["- none"]),
  ].join("\n");
}

export const vipEmailReceived = inngest.createFunction(
  {
    id: "vip/email-received",
    name: "VIP Email Intelligence Pipeline",
    concurrency: { limit: 1 },
    retries: 1,
  },
  { event: "vip/email.received" },
  async ({ event, step }) => {
    const startedAt = Date.now();
    const from = String(event.data.from ?? "");
    const fromName = String(event.data.fromName ?? "");
    const senderDisplay = fromName ? `${fromName} <${from}>` : from;

    if (!isVipSender(from, fromName)) {
      return { status: "noop", reason: "not-vip-sender", from: senderDisplay };
    }

    const subject = String(event.data.subject ?? "");
    const conversationId = String(event.data.conversationId ?? "");
    const preview = String(event.data.preview ?? "");

    const timings: Record<string, number> = {};
    const accessGaps: MissingInfo[] = [];

    const [frontResult, granolaResult, memoryResult, githubResult] = await Promise.all([
      step.run("fetch-front-context", async () => {
        const t0 = Date.now();
        const context = await fetchFrontContext(conversationId);
        const gap = !context
          ? {
              item: "Front thread context",
              why_missing: "Front API token unavailable, timed out, or API call failed",
              how_to_get_it: "Ensure FRONT_API_TOKEN is valid and Front API is reachable",
            }
          : null;

        return { context, gap, durationMs: Date.now() - t0 };
      }),
      step.run("search-granola-related", async () => {
        const t0 = Date.now();
        const rangeDurations: Record<string, number> = {};
        const allMeetings: GranolaMeeting[] = [];

        for (const range of GRANOLA_RANGES) {
          const rangeStart = Date.now();
          const response = parseJsonOutput<Record<string, unknown>>(
            "granola",
            ["meetings", "--range", range],
            GRANOLA_TIMEOUT_MS
          );
          rangeDurations[range] = Date.now() - rangeStart;
          if (!response.ok || !response.data) continue;
          allMeetings.push(...parseGranolaMeetingsResponse(response.data));
        }

        const related = findRelatedMeetings(allMeetings, fromName || from, subject).slice(0, 8);
        const gap = allMeetings.length === 0
          ? {
              item: "Related Granola meetings",
              why_missing: "Granola CLI returned no usable meeting data",
              how_to_get_it: "Verify granola CLI auth and local MCP availability",
            }
          : null;

        return {
          meetings: related,
          gap,
          durationMs: Date.now() - t0,
          rangeDurations,
        };
      }),
      step.run("search-memory-qdrant", async () => {
        const t0 = Date.now();
        const query = `${fromName || from} ${subject}`.trim();
        const proc = spawnSync("joelclaw", ["recall", query, "--limit", "8", "--raw"], {
          encoding: "utf-8",
          timeout: QDRANT_TIMEOUT_MS,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, TERM: "dumb" },
        });

        const durationMs = Date.now() - t0;

        if (proc.status !== 0) {
          return {
            lines: [] as string[],
            durationMs,
            gap: {
              item: "Memory/Qdrant recall",
              why_missing: (proc.stderr ?? proc.stdout ?? "recall command failed").slice(0, 180),
              how_to_get_it: "Ensure Qdrant is up and `joelclaw recall` works in this environment",
            },
          };
        }

        return {
          lines: toLines(proc.stdout ?? "").slice(0, 8),
          durationMs,
          gap: null,
        };
      }),
      step.run("search-github-projects", async () => {
        const t0 = Date.now();
        if (!ENABLE_GITHUB_SEARCH) {
          return {
            repos: [] as GitHubRepo[],
            durationMs: Date.now() - t0,
            skipped: true,
            gap: null,
          };
        }

        const query = `${fromName || from} ${subject}`.trim();
        const response = parseJsonOutput<GitHubRepo[]>(
          "gh",
          ["search", "repos", query, "--limit", "5", "--json", "name,description,url,updatedAt,stargazersCount"],
          GITHUB_TIMEOUT_MS
        );

        return {
          repos: response.ok && response.data ? response.data : [],
          durationMs: Date.now() - t0,
          skipped: false,
          gap: response.ok || !response.error
            ? null
            : {
                item: "GitHub project search",
                why_missing: response.error,
                how_to_get_it: "Authenticate gh CLI and verify network/API access",
              },
        };
      }),
    ]);

    timings["fetch-front-context"] = frontResult.durationMs;
    timings["search-granola-related"] = granolaResult.durationMs;
    timings["search-memory-qdrant"] = memoryResult.durationMs;
    timings["search-github-projects"] = githubResult.durationMs;

    if (frontResult.gap?.item) accessGaps.push(frontResult.gap as MissingInfo);
    if (granolaResult.gap?.item) accessGaps.push(granolaResult.gap as MissingInfo);
    if (memoryResult.gap?.item) accessGaps.push(memoryResult.gap as MissingInfo);
    if (githubResult.gap?.item) accessGaps.push(githubResult.gap as MissingInfo);

    const frontContext = (frontResult.context ?? null) as { summary: Record<string, unknown>; recentMessages: string[] } | null;
    const granolaMeetings = (granolaResult.meetings ?? []) as GranolaMeeting[];
    const memoryContext = (memoryResult.lines ?? []) as string[];
    const githubRepos = (githubResult.repos ?? []) as GitHubRepo[];

    const analysisPrompt = buildAnalysisPrompt({
      senderDisplay,
      subject,
      conversationId,
      preview,
      frontContext,
      granolaMeetings,
      memoryContext,
      githubRepos,
      accessGaps,
    });

    const triageResult = await step.run("sonnet-initial-triage", async () => {
      const t0 = Date.now();
      const proc = spawnSync(
        "pi",
        ["-p", "--no-session", "--no-extensions", "--model", TRIAGE_MODEL, "--system-prompt", VIP_TRIAGE_PROMPT, analysisPrompt],
        {
          encoding: "utf-8",
          timeout: TRIAGE_TIMEOUT_MS,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, TERM: "dumb" },
        }
      );

      const stdout = (proc.stdout ?? "").trim();
      const stderr = (proc.stderr ?? "").trim();
      const durationMs = Date.now() - t0;

      if (proc.status !== 0 && !stdout) {
        return {
          decision: {
            needs_opus: false,
            complexity: "medium",
            reason: `triage failed: ${stderr.slice(0, 200)}`,
            analysis: parseVipAnalysis(""),
          },
          durationMs,
          error: stderr.slice(0, 250),
        };
      }

      return {
        decision: parseTriageDecision(stdout),
        durationMs,
        error: proc.status !== 0 ? stderr.slice(0, 250) : undefined,
      };
    });

    timings["sonnet-initial-triage"] = triageResult.durationMs;

    if (triageResult.error) {
      accessGaps.push({
        item: "Sonnet triage",
        why_missing: triageResult.error,
        how_to_get_it: "Check pi model access and CLI auth",
      });
    }

    const elapsedAfterTriage = Date.now() - startedAt;
    const remainingBudgetMs = TOTAL_BUDGET_MS - elapsedAfterTriage;
    const shouldRunOpus = ENABLE_OPUS_ESCALATION
      && triageResult.decision.needs_opus
      && remainingBudgetMs >= MIN_OPUS_TIME_REMAINING_MS;

    const finalAnalysis = shouldRunOpus
      ? await step.run("opus-vip-analysis", async () => {
          const t0 = Date.now();
          const timeoutMs = Math.min(OPUS_TIMEOUT_MS, Math.max(2_000, remainingBudgetMs - 1_000));
          const result = runModelAnalysis(VIP_MODEL, VIP_SYSTEM_PROMPT, analysisPrompt, timeoutMs);
          return {
            ...result,
            durationMs: Date.now() - t0,
          };
        })
      : {
          analysis: triageResult.decision.analysis,
          error: undefined,
          durationMs: 0,
        };

    timings["opus-vip-analysis"] = finalAnalysis.durationMs;

    if (!shouldRunOpus && triageResult.decision.needs_opus) {
      accessGaps.push({
        item: "Deep Opus analysis",
        why_missing: `Skipped to keep within ${TOTAL_BUDGET_MS}ms budget`,
        how_to_get_it: "Increase JOELCLAW_VIP_TOTAL_BUDGET_MS or force JOELCLAW_VIP_ENABLE_OPUS_ESCALATION=1 with higher budget",
      });
    }

    if (finalAnalysis.error) {
      accessGaps.push({
        item: "Deep model analysis",
        why_missing: finalAnalysis.error,
        how_to_get_it: "Check pi model access and CLI auth",
      });
    }

    const analysis = finalAnalysis.analysis;

    const createdTodos = await step.run("create-comprehensive-todos", async () => {
      const t0 = Date.now();
      const taskAdapter = new TodoistTaskAdapter();
      const created: Array<{ id: string; content: string }> = [];
      const todos = analysis.todos.slice(0, 10);

      for (const todo of todos) {
        try {
          const description = [
            `VIP email source: ${senderDisplay}`,
            `Subject: ${subject}`,
            `Conversation: ${conversationId}`,
            "",
            todo.description,
          ].filter(Boolean).join("\n");

          const task = await taskAdapter.createTask({
            content: `[VIP] ${todo.title}`,
            description,
            priority: normalizePriority(todo.priority),
            dueString: todo.due,
          });

          created.push({ id: task.id, content: task.content });
        } catch (error) {
          accessGaps.push({
            item: `Todo creation failed for: ${todo.title}`,
            why_missing: error instanceof Error ? error.message.slice(0, 180) : String(error).slice(0, 180),
            how_to_get_it: "Check TODOIST_API_TOKEN and todoist-cli availability",
          });
        }
      }

      return { created, durationMs: Date.now() - t0 };
    });

    timings["create-comprehensive-todos"] = createdTodos.durationMs;

    const allMissingInfo = [
      ...analysis.missing_information,
      ...accessGaps,
    ];

    await step.run("notify-vip-summary", async () => {
      const t0 = Date.now();
      const lines: string[] = [
        "## VIP Email Deep Dive",
        "",
        `From: ${senderDisplay}`,
        `Subject: ${subject}`,
        `Model: ${shouldRunOpus ? VIP_MODEL : TRIAGE_MODEL}`,
        `Triage: ${triageResult.decision.complexity} (${triageResult.decision.reason})`,
        "",
        `Summary: ${analysis.executive_summary}`,
      ];

      if (analysis.interaction_signals.length > 0) {
        lines.push("", "Signals:");
        for (const signal of analysis.interaction_signals.slice(0, 8)) {
          lines.push(`- ${signal}`);
        }
      }

      if (createdTodos.created.length > 0) {
        lines.push("", `Todos created (${createdTodos.created.length}):`);
        for (const todo of createdTodos.created) {
          lines.push(`- ${todo.content} (${todo.id})`);
        }
      }

      if (allMissingInfo.length > 0) {
        lines.push("", "Missing information / access gaps:");
        for (const gap of allMissingInfo.slice(0, 12)) {
          lines.push(`- ${gap.item}: ${gap.why_missing}`);
        }
      }

      if (analysis.questions_for_human.length > 0) {
        lines.push("", "Questions for Joel:");
        for (const question of analysis.questions_for_human.slice(0, 6)) {
          lines.push(`- ${question}`);
        }
      }

      const totalMs = Date.now() - startedAt;
      lines.push("", "Timing profile (ms):");
      lines.push(`- fetch-front-context: ${timings["fetch-front-context"] ?? 0}`);
      lines.push(`- search-granola-related: ${timings["search-granola-related"] ?? 0}`);
      lines.push(`- search-memory-qdrant: ${timings["search-memory-qdrant"] ?? 0}`);
      lines.push(`- search-github-projects: ${timings["search-github-projects"] ?? 0}${githubResult.skipped ? " (skipped)" : ""}`);
      lines.push(`- sonnet-initial-triage: ${timings["sonnet-initial-triage"] ?? 0}`);
      lines.push(`- opus-vip-analysis: ${timings["opus-vip-analysis"] ?? 0}`);
      lines.push(`- create-comprehensive-todos: ${timings["create-comprehensive-todos"] ?? 0}`);
      lines.push(`- total: ${totalMs}`);

      await pushGatewayEvent({
        type: "vip.email.received",
        source: "inngest/vip-email-received",
        payload: {
          prompt: lines.join("\n"),
          from,
          fromName,
          subject,
          conversationId,
          todosCreated: createdTodos.created.length,
          missingInfoCount: allMissingInfo.length,
          relatedMeetingCount: granolaMeetings.length,
          memoryContextCount: memoryContext.length,
          githubRepoCount: githubRepos.length,
          triageComplexity: triageResult.decision.complexity,
          triageNeedsOpus: triageResult.decision.needs_opus,
          ranOpus: shouldRunOpus,
          timings,
          granolaRangeDurations: granolaResult.rangeDurations,
          totalDurationMs: totalMs,
        },
      });

      return { durationMs: Date.now() - t0 };
    });

    const totalDurationMs = Date.now() - startedAt;

    return {
      status: "processed",
      model: shouldRunOpus ? VIP_MODEL : TRIAGE_MODEL,
      from: senderDisplay,
      subject,
      relatedMeetings: granolaMeetings.length,
      memoryMatches: memoryContext.length,
      githubRepos: githubRepos.length,
      todosCreated: createdTodos.created.length,
      missingInfoCount: allMissingInfo.length,
      triageComplexity: triageResult.decision.complexity,
      triageNeedsOpus: triageResult.decision.needs_opus,
      ranOpus: shouldRunOpus,
      timings,
      granolaRangeDurations: granolaResult.rangeDurations,
      totalDurationMs,
      budgetMs: TOTAL_BUDGET_MS,
      budgetExceeded: totalDurationMs > TOTAL_BUDGET_MS,
    };
  }
);
