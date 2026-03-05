import { execFileSync } from "node:child_process";
import { NonRetriableError } from "inngest";
import { infer } from "../../../lib/inference";
import { inngest } from "../../client";

const FRONT_QUERY = "is:open is:unreplied";
const FRONT_LIMIT = 50;
const DEFAULT_LOOKBACK_HOURS = 24;
const MIN_LOOKBACK_HOURS = 1;
const MAX_LOOKBACK_HOURS = 168;
const JOEL_SLACK_USER_ID = "U030BJ3CK";
const VIP_CHANNELS = [
  "cc-matt-p",
  "cc-alex-hillman",
  "cc-john",
  "epic-instructors",
  "lc-ai-hero",
  "brain-joel",
  "brain-john",
] as const;

const ACTION_ITEM_SYSTEM_PROMPT = `You are extracting action items for Joel from his email and Slack. Each action item should be a concrete next physical action (verb-first). Only extract items that genuinely need Joel's attention or response. Skip automated notifications, newsletters, and noise. Return JSON array of {title: string, description: string, source: 'email' | 'slack', sourceId: string, priority: 'p2' | 'p3' | 'p4'}`;

type Scope = "all" | "email" | "slack";
type ActionItemSource = "email" | "slack";
type ActionPriority = "p2" | "p3" | "p4";

type EmailCandidate = {
  source: "email";
  sourceId: string;
  subject: string;
  from: string;
  date: string;
};

type SlackCandidate = {
  source: "slack";
  sourceId: string;
  channelId: string;
  channelName: string;
  user: string;
  text: string;
  ts: string;
  permalink?: string;
};

type ActionItem = {
  title: string;
  description: string;
  source: ActionItemSource;
  sourceId: string;
  priority: ActionPriority;
};

type CreatedTask = ActionItem & {
  created: boolean;
  output?: string;
  error?: string;
};

type FrontInboxPayload = {
  result?: {
    conversations?: Array<{
      id?: string;
      subject?: string;
      date?: string;
      from?: {
        name?: string;
        email?: string;
      };
    }>;
  };
};

type SlackSearchResponse = {
  ok: boolean;
  error?: string;
  messages?: {
    matches?: Array<{
      ts?: string;
      text?: string;
      user?: string;
      username?: string;
      permalink?: string;
      channel?: {
        id?: string;
        name?: string;
      };
    }>;
  };
};

type SlackSearchMatch = NonNullable<NonNullable<SlackSearchResponse["messages"]>["matches"]>[number];

function parseScope(value: unknown): Scope {
  if (value === "email" || value === "slack" || value === "all") {
    return value;
  }
  return "all";
}

function parseLookbackHours(value: unknown): number {
  if (value == null) return DEFAULT_LOOKBACK_HOURS;
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    throw new NonRetriableError("hours must be a finite number");
  }
  const normalized = Math.trunc(parsed);
  if (normalized < MIN_LOOKBACK_HOURS || normalized > MAX_LOOKBACK_HOURS) {
    throw new NonRetriableError(`hours must be between ${MIN_LOOKBACK_HOURS} and ${MAX_LOOKBACK_HOURS}`);
  }
  return normalized;
}

function runCli(command: string, args: string[], timeout = 60_000): string {
  try {
    return execFileSync(command, args, {
      encoding: "utf-8",
      timeout,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env },
    }).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${command} ${args.join(" ")} failed: ${message}`);
  }
}

function parseFrontCandidates(payload: unknown): EmailCandidate[] {
  const data = payload as FrontInboxPayload | null;
  const conversations = Array.isArray(data?.result?.conversations)
    ? data.result.conversations
    : [];

  return conversations
    .map((conversation): EmailCandidate | null => {
      const sourceId = conversation.id?.trim();
      if (!sourceId) return null;

      const subject = (conversation.subject ?? "").trim();
      const fromName = conversation.from?.name?.trim();
      const fromEmail = conversation.from?.email?.trim();
      const from = fromName && fromEmail
        ? `${fromName} <${fromEmail}>`
        : fromName || fromEmail || "unknown";
      const date = (conversation.date ?? "").trim() || new Date().toISOString().slice(0, 10);

      return {
        source: "email",
        sourceId,
        subject: subject || "(no subject)",
        from,
        date,
      };
    })
    .filter((item): item is EmailCandidate => item !== null);
}

function leaseSlackUserToken(): string {
  const token = runCli("secrets", ["lease", "slack_user_token", "--ttl", "1h"], 10_000);
  if (!token) {
    throw new NonRetriableError("secrets lease returned empty value for slack_user_token");
  }
  return token;
}

async function searchSlackMessages(token: string, query: string): Promise<SlackSearchMatch[]> {
  const params = new URLSearchParams({
    query,
    count: "40",
    sort: "timestamp",
    sort_dir: "desc",
    highlight: "false",
  });

  const response = await fetch(`https://slack.com/api/search.messages?${params.toString()}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw new Error(`Slack search.messages failed with HTTP ${response.status}`);
  }

  const payload = (await response.json()) as SlackSearchResponse;
  if (!payload.ok) {
    throw new Error(`Slack search.messages failed: ${payload.error ?? "unknown_error"}`);
  }

  return payload.messages?.matches ?? [];
}

function normalizeSlackCandidates(
  matches: SlackSearchMatch[]
): SlackCandidate[] {
  const seen = new Set<string>();
  const candidates: SlackCandidate[] = [];

  for (const match of matches) {
    const ts = match.ts?.trim();
    const channelId = match.channel?.id?.trim();
    const channelName = match.channel?.name?.trim();
    if (!ts || !channelId || !channelName) continue;

    const sourceId = `${channelId}:${ts}`;
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);

    const text = (match.text ?? "").trim();
    const user = (match.username ?? match.user ?? "unknown").trim() || "unknown";

    candidates.push({
      source: "slack",
      sourceId,
      channelId,
      channelName,
      user,
      text,
      ts,
      ...(match.permalink?.trim() ? { permalink: match.permalink.trim() } : {}),
    });
  }

  return candidates;
}

function extractArrayFromText(raw: string): unknown[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    const start = trimmed.indexOf("[");
    const end = trimmed.lastIndexOf("]");
    if (start === -1 || end <= start) return [];
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}

function parsePriority(value: unknown): ActionPriority {
  return value === "p2" || value === "p3" || value === "p4" ? value : "p3";
}

function normalizeActionItems(value: unknown): ActionItem[] {
  const rows = Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  const normalized: ActionItem[] = [];

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const candidate = row as Record<string, unknown>;
    const title = String(candidate.title ?? "").trim();
    const source = candidate.source === "email" || candidate.source === "slack"
      ? candidate.source
      : null;
    const sourceId = String(candidate.sourceId ?? "").trim();
    if (!title || !source || !sourceId) continue;

    const key = `${source}:${sourceId}:${title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    normalized.push({
      title: title.slice(0, 220),
      description: String(candidate.description ?? "").trim().slice(0, 4000),
      source,
      sourceId,
      priority: parsePriority(candidate.priority),
    });
  }

  return normalized;
}

function actionPrompt(emailItems: EmailCandidate[], slackItems: SlackCandidate[]): string {
  const emailBlock = emailItems.length > 0
    ? emailItems
      .map((item) => `sourceId=${item.sourceId} | date=${item.date} | from=${item.from} | subject=${item.subject}`)
      .join("\n")
    : "(none)";

  const slackBlock = slackItems.length > 0
    ? slackItems
      .map((item) => [
        `sourceId=${item.sourceId}`,
        `channel=#${item.channelName}`,
        `user=${item.user}`,
        `ts=${item.ts}`,
        `text=${item.text || "(no text)"}`,
      ].join(" | "))
      .join("\n")
    : "(none)";

  return [
    "Extract action items from the following channel intelligence scan.",
    "Only return actionable items that require Joel's attention or response.",
    "",
    `Email candidates (${emailItems.length}):`,
    emailBlock,
    "",
    `Slack candidates (${slackItems.length}):`,
    slackBlock,
  ].join("\n");
}

function todoistPriority(priority: ActionPriority): "1" | "2" | "3" {
  if (priority === "p2") return "3";
  if (priority === "p3") return "2";
  return "1";
}

function todoistDescription(item: ActionItem): string {
  const parts = [item.description.trim(), `Source: ${item.source} (${item.sourceId})`].filter(Boolean);
  return parts.join("\n\n");
}

export const channelIntelligenceTodoist = inngest.createFunction(
  {
    id: "channel-intelligence-todoist",
    concurrency: { limit: 1, key: '"channel-intelligence-todoist"' },
    retries: 3,
  },
  { event: "channel/intelligence.triage.requested" },
  async ({ event, step }) => {
    const scope = parseScope(event.data.scope);
    const hours = parseLookbackHours(event.data.hours);

    const emailCandidates = await step.run("scan-front-unreplied", async () => {
      if (scope === "slack") return [] as EmailCandidate[];

      const raw = runCli("joelclaw", ["email", "inbox", "-q", FRONT_QUERY, "-n", String(FRONT_LIMIT)], 90_000);
      const parsed = JSON.parse(raw) as FrontInboxPayload;
      return parseFrontCandidates(parsed);
    });

    const slackCandidates = await step.run("scan-slack-vip", async () => {
      if (scope === "email") return [] as SlackCandidate[];

      const token = leaseSlackUserToken();
      const afterUnix = Math.floor(Date.now() / 1000) - hours * 60 * 60;
      const queries = [
        ...VIP_CHANNELS.map((channel) => `in:#${channel} after:${afterUnix}`),
        `<@${JOEL_SLACK_USER_ID}> after:${afterUnix}`,
      ];

      const rawMatches: SlackSearchMatch[] = [];
      for (const query of queries) {
        const matches = await searchSlackMessages(token, query);
        rawMatches.push(...matches);
      }

      return normalizeSlackCandidates(rawMatches);
    });

    const extractedItems = await step.run("extract-action-items", async () => {
      if (emailCandidates.length === 0 && slackCandidates.length === 0) {
        return [] as ActionItem[];
      }

      const prompt = actionPrompt(emailCandidates, slackCandidates);
      const result = await infer(prompt, {
        task: "classification",
        system: ACTION_ITEM_SYSTEM_PROMPT,
        json: true,
        requireJson: true,
        requireTextOutput: true,
        component: "channel-intelligence-todoist",
        action: "channel.intelligence.extract",
        metadata: {
          scope,
          hours,
          emailCandidates: emailCandidates.length,
          slackCandidates: slackCandidates.length,
        },
      });

      const parsedRows = Array.isArray(result.data) ? result.data : extractArrayFromText(result.text);
      return normalizeActionItems(parsedRows);
    });

    const createdItems = await step.run("create-todoist-tasks", async () => {
      if (extractedItems.length === 0) return [] as CreatedTask[];

      const created: CreatedTask[] = [];
      for (const item of extractedItems) {
        try {
          const output = runCli(
            "todoist-cli",
            [
              "add",
              item.title,
              "--description",
              todoistDescription(item),
              "--priority",
              todoistPriority(item.priority),
            ],
            30_000,
          );
          console.log(`[channel-intelligence-todoist] created: ${item.title} (${item.source}:${item.sourceId})`);
          created.push({
            ...item,
            created: true,
            ...(output ? { output: output.slice(0, 500) } : {}),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(
            `[channel-intelligence-todoist] failed: ${item.title} (${item.source}:${item.sourceId}) -> ${message}`,
          );
          created.push({
            ...item,
            created: false,
            error: message,
          });
        }
      }

      return created;
    });

    return step.run("return-summary", async () => ({
      tasksCreated: createdItems.filter((item) => item.created).length,
      sources: {
        email: emailCandidates.length,
        slack: slackCandidates.length,
      },
      items: createdItems,
    }));
  }
);
