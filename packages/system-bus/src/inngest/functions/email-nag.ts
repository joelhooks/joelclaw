import { spawnSync } from "node:child_process";
import type { EmailPort } from "@joelclaw/email";
import { inngest } from "../client";
import { pushGatewayEvent } from "./agent-loop/utils";

type EmailModule = typeof import("@joelclaw/email");

type OpenConversation = {
  id: string;
  subject: string;
  from: string;
};

type AwaitingReply = {
  id: string;
  subject: string;
  from: string;
  waitMs: number;
  waitLabel: string;
};

const MIN_WAIT_MS = 4 * 60 * 60 * 1000;

async function loadEmailModule(): Promise<EmailModule> {
  return import("@joelclaw/email");
}

function leaseFrontApiToken(): string {
  const result = spawnSync("secrets", ["lease", "front_api_token", "--ttl", "1h"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`;
    throw new Error(`failed to lease front_api_token: ${detail}`);
  }

  const token = result.stdout.trim();
  if (!token) {
    throw new Error("failed to lease front_api_token: empty token");
  }

  return token;
}

function formatSender(name: string | undefined, email: string): string {
  const trimmed = name?.trim();
  return trimmed?.length ? trimmed : email;
}

function formatWait(ms: number): string {
  const totalHours = Math.max(1, Math.floor(ms / (60 * 60 * 1000)));
  const days = Math.floor(totalHours / 24);
  if (days >= 1) {
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  return `${totalHours} hour${totalHours === 1 ? "" : "s"}`;
}

async function fetchOpenUnreadConversations(adapter: EmailPort): Promise<OpenConversation[]> {
  const inboxes = await adapter.listInboxes();
  const inboxIds = inboxes.length > 0 ? inboxes.map((inbox) => inbox.id) : ["default"];
  const byId = new Map<string, OpenConversation>();

  for (const inboxId of inboxIds) {
    const [openConversations, unreadConversations] = await Promise.all([
      adapter.listConversations(inboxId, { query: "is:open", limit: 100 }),
      adapter.listConversations(inboxId, { unread: true, limit: 100 }),
    ]);

    for (const convo of [...openConversations, ...unreadConversations]) {
      if (!byId.has(convo.id)) {
        byId.set(convo.id, {
          id: convo.id,
          subject: convo.subject || "(no subject)",
          from: formatSender(convo.from.name, convo.from.email),
        });
      }
    }
  }

  return [...byId.values()];
}

export const emailNag = inngest.createFunction(
  {
    id: "email-nag",
    name: "Email Nag",
    retries: 3,
    concurrency: { limit: 1 },
  },
  [{ cron: "0 17,22 * * *" }],
  async ({ step }) => {
    const frontApiToken = await step.run("lease-front-api-token", async () => {
      return leaseFrontApiToken();
    });

    const openUnreadConversations = await step.run("fetch-open-unread-conversations", async () => {
      const email = await loadEmailModule();
      const adapter = email.createFrontAdapter({ apiToken: frontApiToken });
      return fetchOpenUnreadConversations(adapter);
    });

    if (openUnreadConversations.length === 0) {
      return { status: "noop", reason: "no open or unread conversations" };
    }

    const awaitingReply = await step.run("filter-awaiting-reply", async (): Promise<AwaitingReply[]> => {
      const email = await loadEmailModule();
      const adapter = email.createFrontAdapter({ apiToken: frontApiToken });
      const now = Date.now();
      const waiting: AwaitingReply[] = [];

      for (const convo of openUnreadConversations) {
        const { messages } = await adapter.getConversation(convo.id);
        if (messages.length === 0) continue;

        const latestMessage = messages.reduce((latest, current) => {
          if (!latest) return current;
          return current.date.getTime() > latest.date.getTime() ? current : latest;
        }, messages[0] ?? null);

        if (!latestMessage || !latestMessage.isInbound) continue;

        const ageMs = now - latestMessage.date.getTime();
        if (ageMs < MIN_WAIT_MS) continue;

        waiting.push({
          id: convo.id,
          subject: convo.subject,
          from: convo.from,
          waitMs: ageMs,
          waitLabel: formatWait(ageMs),
        });
      }

      waiting.sort((a, b) => b.waitMs - a.waitMs);
      return waiting;
    });

    if (awaitingReply.length === 0) {
      return {
        status: "noop",
        reason: "no conversations awaiting Joel older than 4 hours",
        checked: openUnreadConversations.length,
      };
    }

    await step.run("notify-gateway", async () => {
      const lines = awaitingReply.map((item) =>
        `- **${item.subject}** from ${item.from} (${item.waitLabel})\n  [Open in Front](https://app.frontapp.com/open/${item.id})`
      );

      await pushGatewayEvent({
        type: "email.awaiting.reply",
        source: "inngest/email-nag",
        payload: {
          prompt: ["## ⏰ Emails Awaiting Your Reply", "", ...lines].join("\n"),
        },
      });
    });

    return {
      status: "nagged",
      checked: openUnreadConversations.length,
      awaitingReply: awaitingReply.length,
      oldest: awaitingReply[0]?.waitLabel ?? null,
    };
  }
);
