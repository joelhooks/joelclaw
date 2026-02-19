/**
 * Email inbox cleanup — durable Inngest function.
 *
 * Paginates through open Front conversations, uses LLM inference
 * to classify each batch (archive vs keep), then archives noise.
 *
 * Triggered by: email/inbox.cleanup
 * ADR-0052: Email Port — Hexagonal Architecture
 */

import { inngest } from "../client";
import type { GatewayContext } from "../middleware/gateway";
import { execSync } from "child_process";

const FRONT_API = "https://api2.frontapp.com";
const BATCH_SIZE = 50; // conversations per LLM classification call
const PAGE_SIZE = 100; // Front API page size
const MAX_PAGES = 20; // safety cap: 20 pages × 100 = 2000 conversations per run

type ConversationSummary = {
  id: string;
  subject: string;
  from: string;
  email: string;
  date: string;
};

function getApiToken(): string {
  const token = process.env.FRONT_API_TOKEN;
  if (!token) throw new Error("FRONT_API_TOKEN not set");
  return token;
}

function getAnthropicKey(): string {
  let key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    try {
      key = execSync("secrets lease anthropic_api_key --ttl 1h 2>/dev/null", {
        encoding: "utf-8",
      }).trim();
    } catch {}
  }
  if (!key) throw new Error("No ANTHROPIC_API_KEY available");
  return key;
}

async function frontGet(path: string, token: string): Promise<any> {
  const res = await fetch(`${FRONT_API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`Front API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function classifyBatch(
  conversations: ConversationSummary[],
  apiKey: string,
): Promise<{ archive: string[]; keep: string[] }> {
  const listing = conversations
    .map(
      (c, i) =>
        `${i + 1}. [${c.id}] From: ${c.from} <${c.email}> | Date: ${c.date} | Subject: ${c.subject}`,
    )
    .join("\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content: `You are triaging Joel's email inbox. Classify each conversation as ARCHIVE or KEEP.

ARCHIVE if:
- Marketing, promotions, sales outreach, cold emails
- Automated notifications nobody reads (CI failures, usage alerts, subscriber counts)
- Newsletters Joel doesn't actively read or that are low-signal
- Duplicate notifications (same sender, same content pattern)
- Expired events, resolved alerts, stale login codes
- Service receipts and billing confirmations (already processed)
- Product update announcements from tools
- Mailing list messages with no personal content

KEEP if:
- Real person writing to Joel personally (colleagues, collaborators, friends)
- Active threads where someone is waiting for a reply (Re: prefix + real person)
- [aih] tagged messages (AI Hero collaboration — always keep)
- Financial documents needing action (tax docs, unusual charges)
- Calendar invites from known contacts needing RSVP
- Content Joel specifically subscribes to and reads (The Information, Astral Codex Ten, specific Substacks from people he knows)
- Anything ambiguous — when in doubt, KEEP

Here are the conversations:

${listing}

Respond with ONLY valid JSON, no markdown fencing:
{"archive": ["cnv_xxx", "cnv_yyy"], "keep": ["cnv_zzz"]}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${body}`);
  }

  const data = (await res.json()) as {
    content: Array<{ type: string; text: string }>;
  };
  const text = data.content[0]?.text ?? "{}";

  try {
    // Strip markdown code fences if present
    const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    return JSON.parse(cleaned);
  } catch {
    // If parsing fails, keep everything (safe default)
    return {
      archive: [],
      keep: conversations.map((c) => c.id),
    };
  }
}

// ── Main function ───────────────────────────────────────────────────

export const emailInboxCleanup = inngest.createFunction(
  {
    id: "email-inbox-cleanup",
    name: "Email → Inbox Cleanup (AI Triage)",
    concurrency: [{ limit: 1 }], // only one cleanup at a time
  },
  { event: "email/inbox.cleanup" },
  async ({ event, step, ...rest }) => {
    const gateway = (rest as any).gateway as GatewayContext | undefined;
    const query = event.data?.query ?? "is:open";
    const maxPages = Math.min(event.data?.maxPages ?? MAX_PAGES, MAX_PAGES);
    const dryRun = event.data?.dryRun ?? false;

    // Step 1: Get API keys
    const keys = await step.run("get-credentials", () => {
      return {
        frontToken: getApiToken(),
        anthropicKey: getAnthropicKey(),
      };
    });

    // Step 2: Paginate and classify
    let totalArchived = 0;
    let totalKept = 0;
    let totalProcessed = 0;
    let nextPageUrl: string | null = null;
    let pageNum = 0;

    while (pageNum < maxPages) {
      const page = pageNum; // capture for step ID

      // Fetch a page of conversations
      const pageData = await step.run(`fetch-page-${page}`, async () => {
        const url = nextPageUrl
          ? nextPageUrl
          : `/conversations/search/${encodeURIComponent(query)}?limit=${PAGE_SIZE}`;

        const data = await frontGet(url, keys.frontToken);
        const conversations: ConversationSummary[] = (
          data._results ?? []
        ).map((c: any) => ({
          id: c.id,
          subject: (c.subject ?? "(no subject)").slice(0, 100),
          from: ((c.recipient?.name ?? "").slice(0, 40)),
          email: (c.recipient?.handle ?? "unknown"),
          date: new Date(
            (c.last_message_at ?? c.created_at ?? 0) * 1000,
          )
            .toISOString()
            .slice(0, 10),
        }));

        return {
          conversations,
          total: data._total ?? 0,
          nextUrl: data._pagination?.next ?? null,
        };
      });

      if (pageData.conversations.length === 0) break;
      nextPageUrl = pageData.nextUrl;

      // Classify in batches of BATCH_SIZE
      const batches: ConversationSummary[][] = [];
      for (let i = 0; i < pageData.conversations.length; i += BATCH_SIZE) {
        batches.push(pageData.conversations.slice(i, i + BATCH_SIZE));
      }

      for (let b = 0; b < batches.length; b++) {
        const batch = batches[b];

        const classification = await step.run(
          `classify-page-${page}-batch-${b}`,
          async () => {
            return await classifyBatch(batch, keys.anthropicKey);
          },
        );

        const archiveIds = classification.archive ?? [];
        const keepIds = classification.keep ?? [];

        // Archive unless dry run
        if (!dryRun && archiveIds.length > 0) {
          await step.run(`archive-page-${page}-batch-${b}`, async () => {
            let archived = 0;
            let errors = 0;
            for (const id of archiveIds) {
              try {
                const res = await fetch(
                  `${FRONT_API}/conversations/${id}`,
                  {
                    method: "PATCH",
                    headers: {
                      Authorization: `Bearer ${keys.frontToken}`,
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify({ status: "archived" }),
                  },
                );
                if (res.ok || res.status === 204) {
                  archived++;
                } else {
                  errors++;
                }
              } catch {
                errors++;
              }
            }
            return { archived, errors };
          });
        }

        totalArchived += archiveIds.length;
        totalKept += keepIds.length;
        totalProcessed += batch.length;
      }

      pageNum++;
      if (!nextPageUrl) break;

      // Breathing room for rate limits
      if (pageNum < maxPages && nextPageUrl) {
        await step.sleep(`rate-limit-pause-${page}`, "2s");
      }
    }

    // Final summary
    const summary = {
      query,
      dryRun,
      pagesProcessed: pageNum,
      totalProcessed,
      totalArchived,
      totalKept,
    };

    // Notify gateway with results
    await step.run("notify-results", async () => {
      if (!gateway) return { pushed: false };

      const emoji = dryRun ? "🔍" : "🧹";
      const action = dryRun ? "DRY RUN" : "COMPLETED";

      return await gateway.notify("email.inbox.cleanup", {
        prompt: [
          `## ${emoji} Inbox Cleanup ${action}`,
          "",
          `**Query**: \`${query}\``,
          `**Processed**: ${totalProcessed} conversations`,
          `**Archived**: ${totalArchived}`,
          `**Kept**: ${totalKept}`,
          `**Pages**: ${pageNum}`,
          "",
          dryRun
            ? "This was a dry run. Re-run with `dryRun: false` to execute."
            : "Archive complete. Run `joelclaw email inbox` to check remaining.",
        ].join("\n"),
      });
    });

    return summary;
  },
);
