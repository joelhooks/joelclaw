/**
 * Email inbox triage — autonomous agent that processes email silently.
 * ADR-0052: Uses EmailPort (Front + Gmail adapters).
 * ADR-0053: Agency triage principle — act, don't narrate.
 *
 * This function DOES the work:
 *   - Archives noise (newsletters, notifications, automated)
 *   - Unsubscribes from junk
 *   - Tags/labels for organization
 *   - Only escalates to gateway when a reply or decision is needed
 *
 * 2h cooldown between runs. Daytime only.
 */

import { inngest } from "../client";
import { parseClaudeOutput, pushGatewayEvent } from "./agent-loop/utils";
import { parsePiJsonAssistant, traceLlmGeneration } from "../../lib/langfuse";
import { getCurrentTasks, hasTaskMatching } from "../../tasks";
import { prefetchMemoryContext } from "../../memory/context-prefetch";
import Redis from "ioredis";

type EmailModule = typeof import("@joelclaw/email");

async function loadEmailModule(): Promise<EmailModule> {
  return import("@joelclaw/email");
}

const COOLDOWN_KEY = "email:triage:last-run";
const COOLDOWN_TTL = 2 * 60 * 60; // 2 hours
// Sonnet 4.6 for email triage — decisions have real consequences (archive wrong = missed reply).
// Haiku is fine for simple categorization (task triage), but email needs judgment.
const TRIAGE_MODEL = "anthropic/claude-sonnet-4-6";

const TRIAGE_SYSTEM_PROMPT = `You triage emails for Joel Hooks. Categorize each email into exactly one action:

- archive: newsletters, notifications, automated alerts, marketing, receipts, shipping updates — anything that doesn't need a response
- unsubscribe: persistent junk, spam-like newsletters Joel never reads, marketing he'd want to stop
- label: useful reference (tag with a label name) but no reply needed. Use labels: "receipts", "shipping", "github", "billing", "reading"
- reply-needed: someone is waiting for Joel's response. A real human wrote to him.
- decision-needed: requires Joel to make a choice (approve something, accept/decline invite, sign off)

Be aggressive about archiving. Joel's inbox should only contain things that need his attention.

Respond ONLY with valid JSON:
{
  "triage": [
    {
      "id": "conversation-id",
      "action": "archive|unsubscribe|label|reply-needed|decision-needed",
      "label": "optional-label-name",
      "reason": "1 sentence why"
    }
  ]
}`;

type TriageAction = "archive" | "unsubscribe" | "label" | "reply-needed" | "decision-needed";

type TriageItem = {
  id: string;
  action: TriageAction;
  label?: string;
  reason: string;
};

type ActionSummary = {
  archived: number;
  unsubscribed: number;
  labeled: number;
  escalated: { subject: string; from: string; reason: string }[];
};

let redisClient: Redis | null = null;

function getRedis(): Redis {
  if (redisClient) return redisClient;
  const isTest = process.env.NODE_ENV === "test" || process.env.BUN_TEST === "1";
  redisClient = new Redis({
    host: process.env.REDIS_HOST ?? "localhost",
    port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
    lazyConnect: true,
    retryStrategy: isTest ? () => null : undefined,
  });
  redisClient.on("error", () => {});
  return redisClient;
}

function isDaytime(): boolean {
  const hour = new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hour12: false });
  const h = parseInt(hour, 10);
  return h >= 8 && h < 22;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object";
}

function normalizeAction(v: unknown): TriageAction | null {
  if (v === "archive" || v === "unsubscribe" || v === "label" || v === "reply-needed" || v === "decision-needed") return v;
  return null;
}

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  return new Response(stream).text();
}

function parseTriageResult(raw: string): TriageItem[] {
  const parsed = parseClaudeOutput(raw);
  if (!isRecord(parsed) || !Array.isArray(parsed.triage)) return [];
  return parsed.triage
    .map((item): TriageItem | null => {
      if (!isRecord(item)) return null;
      const id = String(item.id ?? "").trim();
      const action = normalizeAction(item.action);
      if (!id || !action) return null;
      return {
        id,
        action,
        label: typeof item.label === "string" ? item.label : undefined,
        reason: String(item.reason ?? "").trim(),
      };
    })
    .filter((item): item is TriageItem => item !== null);
}

export const checkEmail = inngest.createFunction(
  {
    id: "check/email-triage",
    concurrency: { limit: 1 },
    retries: 1,
  },
  { event: "email/triage.requested" },
  async ({ step }) => {
    // NOOP: nighttime
    if (!isDaytime()) {
      return { status: "noop", reason: "nighttime" };
    }

    // NOOP: cooldown
    const cooled = await step.run("check-cooldown", async () => {
      const redis = getRedis();
      return !!(await redis.get(COOLDOWN_KEY));
    });
    if (cooled) {
      return { status: "noop", reason: "cooldown active (2h)" };
    }

    // Step 1: Fetch unread from both providers via EmailPort
    const [frontConvos, gmailConvos] = await Promise.all([
      step.run("fetch-front-unread", async () => {
        try {
          const email = await loadEmailModule();
          const adapter = email.createFrontAdapter({ apiToken: process.env.FRONT_API_TOKEN ?? "" });
          const inboxes = await adapter.listInboxes();
          const inboxId = inboxes[0]?.id ?? "default";
          const convos = await adapter.listConversations(inboxId, { unread: true, limit: 25 });
          return convos.map((c) => ({
            id: c.id,
            subject: c.subject,
            from: c.from.name ? `${c.from.name} <${c.from.email}>` : c.from.email,
            preview: c.preview?.slice(0, 120) ?? "",
            tags: c.tags,
            provider: "front" as const,
          }));
        } catch (err) {
          console.error("[check-email] front failed:", err);
          return [];
        }
      }),
      step.run("fetch-gmail-unread", async () => {
        try {
          const email = await loadEmailModule();
          const adapter = email.createGmailAdapter({ account: "joelhooks@gmail.com" });
          const convos = await adapter.listConversations("default", { unread: true, limit: 25 });
          return convos.map((c) => ({
            id: c.id,
            subject: c.subject,
            from: c.from.name ? `${c.from.name} <${c.from.email}>` : c.from.email,
            preview: c.preview?.slice(0, 120) ?? "",
            tags: c.tags,
            provider: "gmail" as const,
          }));
        } catch (err) {
          console.error("[check-email] gmail failed:", err);
          return [];
        }
      }),
    ]);

    const allConvos = [...frontConvos, ...gmailConvos];

    // Set cooldown
    await step.run("set-cooldown", async () => {
      const redis = getRedis();
      await redis.set(COOLDOWN_KEY, new Date().toISOString(), "EX", COOLDOWN_TTL);
    });

    // NOOP: inbox zero
    if (allConvos.length === 0) {
      return { status: "noop", reason: "inbox zero" };
    }

    const memoryContext = await step.run("prefetch-memory", async () => {
      const query = allConvos
        .slice(0, 12)
        .map((c) => `${c.subject} ${c.from}`)
        .join(" | ");
      return prefetchMemoryContext(query, { limit: 5 });
    });

    // Step 2: LLM triage — categorize all emails
    const triageItems = await step.run("llm-triage", async () => {
      const emailLines = allConvos.map((c) => [
        `ID: ${c.id}`,
        `Provider: ${c.provider}`,
        `From: ${c.from}`,
        `Subject: ${c.subject}`,
        `Preview: ${c.preview}`,
        `Tags: ${c.tags.join(", ") || "(none)"}`,
      ].join("\n"));

      const prompt = [
        `Triage these ${allConvos.length} emails. Return one entry per ID.`,
        memoryContext ? `\nRelevant prior context:\n${memoryContext}` : "",
        "",
        emailLines.join("\n\n---\n\n"),
      ].join("\n");
      const systemPrompt = memoryContext
        ? `${TRIAGE_SYSTEM_PROMPT}\n\nUse this memory context when judging sender patterns and urgency:\n${memoryContext}`
        : TRIAGE_SYSTEM_PROMPT;

      const triageStartedAt = Date.now();

      const proc = Bun.spawn(
        [
          "pi",
          "-p",
          "--no-session",
          "--no-extensions",
          "--mode",
          "json",
          "--model",
          TRIAGE_MODEL,
          "--system-prompt",
          systemPrompt,
          prompt,
        ],
        { env: { ...process.env, TERM: "dumb" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      );

      const [stdoutRaw, stderr, exitCode] = await Promise.all([
        readStream(proc.stdout),
        readStream(proc.stderr),
        proc.exited,
      ]);

      const parsedPi = parsePiJsonAssistant(stdoutRaw);
      const assistantText = parsedPi?.text ?? stdoutRaw;

      if (exitCode !== 0 && !assistantText.trim()) {
        const error = `pi triage failed (${exitCode}): ${stderr.trim()}`;
        await traceLlmGeneration({
          traceName: "joelclaw.check-email",
          generationName: "email.triage",
          component: "check-email",
          action: "email.triage.classify",
          input: {
            emailCount: allConvos.length,
            prompt: prompt.slice(0, 6000),
          },
          output: {
            stderr: stderr.trim().slice(0, 500),
          },
          provider: parsedPi?.provider,
          model: parsedPi?.model ?? TRIAGE_MODEL,
          usage: parsedPi?.usage,
          durationMs: Date.now() - triageStartedAt,
          error,
          metadata: {
            emailCount: allConvos.length,
            source: "check-email",
          },
        });
        throw new Error(error);
      }

      const triage = parseTriageResult(assistantText);

      await traceLlmGeneration({
        traceName: "joelclaw.check-email",
        generationName: "email.triage",
        component: "check-email",
        action: "email.triage.classify",
        input: {
          emailCount: allConvos.length,
          prompt: prompt.slice(0, 6000),
        },
        output: {
          triageCount: triage.length,
        },
        provider: parsedPi?.provider,
        model: parsedPi?.model ?? TRIAGE_MODEL,
        usage: parsedPi?.usage,
        durationMs: Date.now() - triageStartedAt,
        metadata: {
          emailCount: allConvos.length,
          source: "check-email",
        },
      });

      return triage;
    });

    // Step 3: Execute autonomous actions (archive, unsubscribe, label)
    const summary = await step.run("execute-triage", async (): Promise<ActionSummary> => {
      const result: ActionSummary = { archived: 0, unsubscribed: 0, labeled: 0, escalated: [] };
      const triageById = new Map(triageItems.map((t) => [t.id, t]));
      const email = await loadEmailModule();

      for (const convo of allConvos) {
        const triage = triageById.get(convo.id);
        if (!triage) continue;

        try {
          const adapter = convo.provider === "front"
            ? email.createFrontAdapter({ apiToken: process.env.FRONT_API_TOKEN ?? "" })
            : email.createGmailAdapter({ account: "joelhooks@gmail.com" });

          switch (triage.action) {
            case "archive":
              await adapter.archive(convo.id);
              result.archived++;
              break;

            case "unsubscribe":
              // Archive + tag as unsubscribe candidate for manual bulk unsubscribe later
              await adapter.archive(convo.id);
              try { await adapter.tag(convo.id, "unsubscribe"); } catch { /* tag may not exist */ }
              result.unsubscribed++;
              break;

            case "label":
              if (triage.label) {
                try { await adapter.tag(convo.id, triage.label); } catch { /* label may not exist */ }
              }
              await adapter.markRead(convo.id);
              result.labeled++;
              break;

            case "reply-needed":
            case "decision-needed":
              result.escalated.push({
                subject: convo.subject,
                from: convo.from,
                reason: triage.reason,
              });
              break;
          }
        } catch (err) {
          console.error(`[check-email] action failed for ${convo.id}:`, err);
        }
      }

      return result;
    });

    // Step 5: Filter escalations against existing tasks — don't nag about what's already tracked
    const filteredEscalations = await step.run("filter-against-tasks", async () => {
      const tasks = await getCurrentTasks();
      return summary.escalated.filter((e) => {
        const senderPrefix = e.from.split("<")[0]?.trim() ?? e.from;
        return !hasTaskMatching(tasks, e.subject) && !hasTaskMatching(tasks, senderPrefix);
      });
    });

    // NOOP: nothing to escalate (all handled silently or already have tasks)
    if (filteredEscalations.length === 0) {
      return {
        status: "handled-silently",
        archived: summary.archived,
        unsubscribed: summary.unsubscribed,
        labeled: summary.labeled,
        total: allConvos.length,
      };
    }

    // Step 6: Only notify gateway for emails that need Joel AND don't have tasks
    await step.run("notify-gateway", async () => {
      const lines = filteredEscalations.map((e) =>
        `- **${e.subject}** from ${e.from}\n  _${e.reason}_`
      );

      const silentSummary = [
        summary.archived > 0 ? `${summary.archived} archived` : "",
        summary.unsubscribed > 0 ? `${summary.unsubscribed} unsubscribed` : "",
        summary.labeled > 0 ? `${summary.labeled} labeled` : "",
      ].filter(Boolean).join(", ");

      await pushGatewayEvent({
        type: "email.needs.attention",
        source: "inngest/check-email",
        payload: {
          prompt: [
            `## 📧 ${filteredEscalations.length} Email${filteredEscalations.length > 1 ? "s" : ""} Need${filteredEscalations.length === 1 ? "s" : ""} You`,
            "",
            ...lines,
            "",
            silentSummary ? `_Also handled silently: ${silentSummary}_` : "",
          ].filter(Boolean).join("\n"),
        },
      });
    });

    return {
      status: "escalated",
      escalated: filteredEscalations.length,
      archived: summary.archived,
      unsubscribed: summary.unsubscribed,
      labeled: summary.labeled,
      total: allConvos.length,
    };
  }
);
