/**
 * Email inbox cleanup — durable Inngest function.
 *
 * Paginates through open Front conversations, uses pi CLI inference
 * to classify each batch (archive vs keep), then archives noise.
 *
 * Triggered by: email/inbox.cleanup
 * ADR-0052: Email Port — Hexagonal Architecture
 */

import { inngest } from "../client";
import type { GatewayContext } from "../middleware/gateway";
import { execSync } from "child_process";

const FRONT_API = "https://api2.frontapp.com";
const BATCH_SIZE = 50; // conversations per classification call
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

/**
 * Classify a batch of conversations using pi CLI inference.
 *
 * Uses `pi --print --no-session --provider anthropic --model sonnet`
 * for fast, cheap classification. No Anthropic API key needed —
 * pi handles auth via its own provider config.
 */
function classifyBatch(
  conversations: ConversationSummary[],
): { archive: string[]; keep: string[] } {
  const listing = conversations
    .map(
      (c, i) =>
        `${i + 1}. [${c.id}] From: ${c.from} <${c.email}> | Date: ${c.date} | Subject: ${c.subject}`,
    )
    .join("\n");

  const prompt = `You are triaging Joel's email inbox. Classify each conversation as ARCHIVE or KEEP.

ARCHIVE if:
- Marketing, promotions, sales outreach, cold emails
- Automated notifications nobody reads (CI failures, usage alerts, subscriber counts)
- Newsletters that are low-signal or mass-market
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
- Content Joel specifically subscribes to and reads (The Information, Astral Codex Ten, Lenny's Newsletter, specific Substacks from people he knows like Kent Beck, Casey Newton)
- Anything ambiguous — when in doubt, KEEP

Here are the conversations:

${listing}

Respond with ONLY valid JSON, no markdown fencing:
{"archive": ["cnv_xxx", "cnv_yyy"], "keep": ["cnv_zzz"]}`;

  try {
    // Write prompt to temp file to avoid shell escaping issues
    const fs = require("fs");
    const tmpFile = `/tmp/email-cleanup-prompt-${Date.now()}.txt`;
    fs.writeFileSync(tmpFile, prompt);

    // Use pi --print with --system-prompt override (skip AGENTS.md loading)
    const { spawnSync } = require("child_process");
    const proc = spawnSync(
      "pi",
      [
        "--print", "--no-session",
        "--provider", "anthropic", "--model", "haiku",
        "--system-prompt", "You classify emails as archive or keep. Respond with ONLY valid JSON, no markdown.",
        fs.readFileSync(tmpFile, "utf-8"),
      ],
      {
        encoding: "utf-8",
        timeout: 120_000,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    // Clean up temp file
    try { fs.unlinkSync(tmpFile); } catch {}

    // Only use stdout — stderr has gateway noise
    const stdout = (proc.stdout ?? "").trim();

    if (proc.status !== 0 && !stdout) {
      console.error("[email-cleanup] pi exited with status", proc.status, proc.stderr?.slice(0, 200));
      return { archive: [], keep: conversations.map((c) => c.id) };
    }

    // Filter out non-JSON lines (gateway registration, extension warnings, markdown fences)
    const lines = stdout.split("\n").filter(
      (l: string) => {
        const t = l.trim();
        return t.length > 0
          && !t.startsWith("[gateway]")
          && !t.startsWith("Failed to load")
          && !t.startsWith("Extension error")
          && !t.startsWith("```");
      },
    );
    const cleaned = lines.join("\n").trim();

    // Try parsing the full cleaned output as JSON
    try {
      return JSON.parse(cleaned);
    } catch {}

    // Try: find lines between { and } that contain archive/keep
    const braceStart = cleaned.indexOf("{");
    const braceEnd = cleaned.lastIndexOf("}");
    if (braceStart !== -1 && braceEnd > braceStart) {
      try {
        return JSON.parse(cleaned.slice(braceStart, braceEnd + 1));
      } catch {}
    }

    console.error("[email-cleanup] No valid JSON in pi response, keeping all. Raw stdout:", stdout.slice(0, 500));
    return { archive: [], keep: conversations.map((c) => c.id) };
  } catch (err) {
    console.error("[email-cleanup] pi inference failed, keeping all:", err);
    return { archive: [], keep: conversations.map((c) => c.id) };
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

    // Step 1: Verify Front API access
    const frontToken = await step.run("get-front-token", () => {
      return getApiToken();
    });

    // Step 2: Paginate and classify
    let totalArchived = 0;
    let totalKept = 0;
    let totalProcessed = 0;
    let nextPageUrl: string | null = null;
    let pageNum = 0;

    while (pageNum < maxPages) {
      const page = pageNum;

      // Fetch a page of conversations
      const pageData = await step.run(`fetch-page-${page}`, async () => {
        let data: any;
        if (nextPageUrl) {
          // Pagination URLs from Front are fully qualified — fetch directly
          const res = await fetch(nextPageUrl, {
            headers: {
              Authorization: `Bearer ${frontToken}`,
              Accept: "application/json",
            },
          });
          if (!res.ok) throw new Error(`Front API ${res.status}: ${await res.text()}`);
          data = await res.json();
        } else {
          data = await frontGet(
            `/conversations/search/${encodeURIComponent(query)}?limit=${PAGE_SIZE}`,
            frontToken,
          );
        }
        const conversations: ConversationSummary[] = (
          data._results ?? []
        ).map((c: any) => ({
          id: c.id,
          subject: (c.subject ?? "(no subject)").slice(0, 100),
          from: (c.recipient?.name ?? "").slice(0, 40),
          email: c.recipient?.handle ?? "unknown",
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

      // Classify in batches of BATCH_SIZE using pi CLI
      const batches: ConversationSummary[][] = [];
      for (let i = 0; i < pageData.conversations.length; i += BATCH_SIZE) {
        batches.push(pageData.conversations.slice(i, i + BATCH_SIZE));
      }

      for (let b = 0; b < batches.length; b++) {
        const batch = batches[b];

        const classification = await step.run(
          `classify-page-${page}-batch-${b}`,
          () => {
            return classifyBatch(batch);
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
                      Authorization: `Bearer ${frontToken}`,
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
