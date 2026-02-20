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

async function fetchFrontContext(conversationId: string): Promise<{ summary: Record<string, unknown>; recentMessages: string[] } | null> {
  const token = readFrontToken();
  if (!token || !conversationId) return null;

  try {
    const convoRes = await fetch(`${FRONT_API}/conversations/${conversationId}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!convoRes.ok) return null;
    const convo = (await convoRes.json()) as Record<string, unknown>;

    const msgRes = await fetch(`${FRONT_API}/conversations/${conversationId}/messages?limit=8`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });

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

export const vipEmailReceived = inngest.createFunction(
  {
    id: "vip/email-received",
    name: "VIP Email Intelligence Pipeline",
    concurrency: { limit: 1 },
    retries: 1,
  },
  { event: "vip/email.received" },
  async ({ event, step }) => {
    const from = String(event.data.from ?? "");
    const fromName = String(event.data.fromName ?? "");
    const senderDisplay = fromName ? `${fromName} <${from}>` : from;

    if (!isVipSender(from, fromName)) {
      return { status: "noop", reason: "not-vip-sender", from: senderDisplay };
    }

    const accessGaps: MissingInfo[] = [];

    const frontContext = await step.run("fetch-front-context", async () => {
      const context = await fetchFrontContext(String(event.data.conversationId ?? ""));
      if (!context) {
        accessGaps.push({
          item: "Front thread context",
          why_missing: "Front API token unavailable or API call failed",
          how_to_get_it: "Ensure FRONT_API_TOKEN is valid and Front API is reachable",
        });
      }
      return context;
    });

    const granolaMeetings = await step.run("search-granola-related", async () => {
      const ranges = ["today", "week", "month", "quarter", "year"];
      const allMeetings: GranolaMeeting[] = [];

      for (const range of ranges) {
        const response = parseJsonOutput<Record<string, unknown>>("granola", ["meetings", "--range", range], 30_000);
        if (!response.ok || !response.data) continue;
        allMeetings.push(...parseGranolaMeetingsResponse(response.data));
      }

      if (allMeetings.length === 0) {
        accessGaps.push({
          item: "Related Granola meetings",
          why_missing: "Granola CLI returned no usable meeting data",
          how_to_get_it: "Verify granola CLI auth and local MCP availability",
        });
      }

      const related = findRelatedMeetings(allMeetings, fromName || from, String(event.data.subject ?? ""));
      return related.slice(0, 8);
    });

    const memoryContext = await step.run("search-memory-qdrant", async () => {
      const query = `${fromName || from} ${String(event.data.subject ?? "")}`.trim();
      const proc = spawnSync("joelclaw", ["recall", query, "--limit", "8", "--raw"], {
        encoding: "utf-8",
        timeout: 45_000,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, TERM: "dumb" },
      });

      if (proc.status !== 0) {
        accessGaps.push({
          item: "Memory/Qdrant recall",
          why_missing: (proc.stderr ?? proc.stdout ?? "recall command failed").slice(0, 180),
          how_to_get_it: "Ensure Qdrant is up and `joelclaw recall` works in this environment",
        });
        return [];
      }

      return toLines(proc.stdout ?? "").slice(0, 8);
    });

    const githubRepos = await step.run("search-github-projects", async () => {
      const query = `${fromName || from} ${String(event.data.subject ?? "")}`.trim();
      const response = parseJsonOutput<GitHubRepo[]>(
        "gh",
        ["search", "repos", query, "--limit", "8", "--json", "name,description,url,updatedAt,stargazersCount"],
        45_000
      );

      if (!response.ok || !response.data) {
        accessGaps.push({
          item: "GitHub project search",
          why_missing: response.error ?? "gh search failed",
          how_to_get_it: "Authenticate gh CLI and verify network/API access",
        });
        return [];
      }

      return response.data;
    });

    const analysis = await step.run("opus-vip-analysis", async () => {
      const relatedMeetingLines = granolaMeetings.map((meeting) => {
        const when = meeting.date ? ` (${meeting.date})` : "";
        return `- ${meeting.title}${when} [${meeting.id}]`;
      });

      const repoLines = githubRepos.map((repo) => {
        const name = repo.name ?? "unknown";
        const description = repo.description ?? "";
        const url = repo.url ?? "";
        return `- ${name}: ${description} ${url}`.trim();
      });

      const prompt = [
        `VIP sender: ${senderDisplay}`,
        `Subject: ${String(event.data.subject ?? "")}`,
        `Conversation ID: ${String(event.data.conversationId ?? "")}`,
        `Preview: ${String(event.data.preview ?? "")}`,
        "",
        "Front conversation summary:",
        JSON.stringify(frontContext?.summary ?? {}, null, 2),
        "",
        "Recent Front messages:",
        ...(frontContext?.recentMessages ?? []),
        "",
        "Related Granola meetings:",
        ...(relatedMeetingLines.length > 0 ? relatedMeetingLines : ["- none found"]),
        "",
        "Memory recall excerpts:",
        ...(memoryContext.length > 0 ? memoryContext : ["- none found"]),
        "",
        "GitHub repositories:",
        ...(repoLines.length > 0 ? repoLines : ["- none found"]),
        "",
        "Access gaps detected before analysis:",
        ...(accessGaps.length > 0
          ? accessGaps.map((gap) => `- ${gap.item}: ${gap.why_missing}. How to get: ${gap.how_to_get_it}`)
          : ["- none"]),
      ].join("\n");

      const proc = spawnSync(
        "pi",
        ["-p", "--no-session", "--no-extensions", "--model", VIP_MODEL, "--system-prompt", VIP_SYSTEM_PROMPT, prompt],
        {
          encoding: "utf-8",
          timeout: 240_000,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, TERM: "dumb" },
        }
      );

      const stdout = (proc.stdout ?? "").trim();
      const stderr = (proc.stderr ?? "").trim();

      if (proc.status !== 0 && !stdout) {
        throw new Error(`VIP Opus analysis failed (${proc.status ?? "unknown"}): ${stderr.slice(0, 250)}`);
      }

      return parseVipAnalysis(stdout);
    });

    const createdTodos = await step.run("create-comprehensive-todos", async () => {
      const taskAdapter = new TodoistTaskAdapter();
      const created: Array<{ id: string; content: string }> = [];
      const todos = analysis.todos.slice(0, 10);

      for (const todo of todos) {
        try {
          const description = [
            `VIP email source: ${senderDisplay}`,
            `Subject: ${String(event.data.subject ?? "")}`,
            `Conversation: ${String(event.data.conversationId ?? "")}`,
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

      return created;
    });

    const allMissingInfo = [
      ...analysis.missing_information,
      ...accessGaps,
    ];

    await step.run("notify-vip-summary", async () => {
      const lines: string[] = [
        "## VIP Email Deep Dive",
        "",
        `From: ${senderDisplay}`,
        `Subject: ${String(event.data.subject ?? "")}`,
        `Model: ${VIP_MODEL}`,
        "",
        `Summary: ${analysis.executive_summary}`,
      ];

      if (analysis.interaction_signals.length > 0) {
        lines.push("", "Signals:");
        for (const signal of analysis.interaction_signals.slice(0, 8)) {
          lines.push(`- ${signal}`);
        }
      }

      if (createdTodos.length > 0) {
        lines.push("", `Todos created (${createdTodos.length}):`);
        for (const todo of createdTodos) {
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

      await pushGatewayEvent({
        type: "vip.email.received",
        source: "inngest/vip-email-received",
        payload: {
          prompt: lines.join("\n"),
          from,
          fromName,
          subject: String(event.data.subject ?? ""),
          conversationId: String(event.data.conversationId ?? ""),
          todosCreated: createdTodos.length,
          missingInfoCount: allMissingInfo.length,
          relatedMeetingCount: granolaMeetings.length,
          memoryContextCount: memoryContext.length,
          githubRepoCount: githubRepos.length,
        },
      });
    });

    return {
      status: "processed",
      model: VIP_MODEL,
      from: senderDisplay,
      subject: String(event.data.subject ?? ""),
      relatedMeetings: granolaMeetings.length,
      memoryMatches: memoryContext.length,
      githubRepos: githubRepos.length,
      todosCreated: createdTodos.length,
      missingInfoCount: allMissingInfo.length,
    };
  }
);
