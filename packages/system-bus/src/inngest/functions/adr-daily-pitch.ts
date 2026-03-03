import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Redis from "ioredis";
import { getRedisPort } from "../../lib/redis";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";

const VAULT_PATH = process.env.VAULT_PATH ?? "/Users/joel/Vault";
const PITCH_HISTORY_KEY = "adr:pitch:history";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

interface AdrItem {
  number: string;
  title: string;
  status: string;
  filename: string;
}

interface PitchRecord {
  adr_number: string;
  pitched_at: string;
  response: "pending" | "approved" | "rejected";
}

interface AdrFrontmatter {
  number: string;
  title: string;
  status: string;
  score: number;
  band: string;
  need: number;
  readiness: number;
  confidence: number;
  novelty: number;
  rationale: string;
}

let redisClient: Redis | null = null;

function getRedis(): Redis {
  if (redisClient) return redisClient;
  const isTest = process.env.NODE_ENV === "test" || process.env.BUN_TEST === "1";
  redisClient = new Redis({
    host: process.env.REDIS_HOST ?? "localhost",
    port: getRedisPort(),
    lazyConnect: true,
    retryStrategy: isTest ? () => null : undefined,
  });
  redisClient.on("error", () => {});
  return redisClient;
}

function parseFrontmatter(content: string, adrNumber: string): AdrFrontmatter | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const fm = fmMatch[1] ?? "";

  const get = (key: string): string => {
    const match = fm.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return match?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
  };

  const getNum = (key: string): number => {
    const val = Number.parseInt(get(key), 10);
    return Number.isNaN(val) ? 0 : val;
  };

  const titleMatch = content.match(/^#\s+ADR-\d+:\s*(.+)$/m);
  const title = titleMatch?.[1]?.trim() ?? get("title") ?? `ADR-${adrNumber}`;

  return {
    number: adrNumber,
    title,
    status: get("status"),
    score: getNum("priority-score"),
    band: get("priority-band"),
    need: getNum("priority-need"),
    readiness: getNum("priority-readiness"),
    confidence: getNum("priority-confidence"),
    novelty: getNum("priority-novelty"),
    rationale: get("priority-rationale"),
  };
}

async function updatePitchHistoryResponse(
  adrNumber: string | number,
  response: "approved" | "rejected",
): Promise<boolean> {
  const redis = getRedis();
  const historyRaw = await redis.get(PITCH_HISTORY_KEY);
  const history: PitchRecord[] = historyRaw ? (JSON.parse(historyRaw) as PitchRecord[]) : [];

  // Normalize: "0186", "186", 186 all match "0186"
  const needle = String(adrNumber).padStart(4, "0");

  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    const entryNorm = String(entry?.adr_number ?? "").padStart(4, "0");
    if (entry && entryNorm === needle && entry.response === "pending") {
      entry.response = response;
      await redis.set(PITCH_HISTORY_KEY, JSON.stringify(history));
      return true;
    }
  }

  return false;
}

export const adrDailyPitch = inngest.createFunction(
  {
    id: "adr-daily-pitch",
    name: "ADR: Daily Work Pitch",
    retries: 2,
  },
  { event: "adr/pitch.requested" },
  async ({ step }) => {
    // Step 1: Read and rank open ADRs
    const candidates = await step.run("rank-open-adrs", () => {
      let raw: string;
      try {
        raw = execSync("joelclaw vault adr list --json 2>/dev/null || joelclaw vault adr list", {
          encoding: "utf-8",
          timeout: 10_000,
        });
      } catch {
        return [] as AdrFrontmatter[];
      }

      let items: AdrItem[];
      try {
        const parsed = JSON.parse(raw) as { result?: { items?: AdrItem[] } };
        items = parsed?.result?.items ?? [];
      } catch {
        return [] as AdrFrontmatter[];
      }

      const openStatuses = new Set(["proposed", "accepted"]);
      const open = items.filter((i) => openStatuses.has(i.status));

      const scored: AdrFrontmatter[] = [];
      for (const item of open) {
        try {
          const filePath = join(VAULT_PATH, "docs/decisions", item.filename);
          const content = readFileSync(filePath, "utf-8");
          const fm = parseFrontmatter(content, item.number);
          if (fm && fm.band === "do-now" && fm.confidence >= 4 && fm.score >= 80) {
            scored.push(fm);
          }
        } catch {
          // skip unreadable ADRs
        }
      }

      scored.sort((a, b) => b.score - a.score);
      return scored;
    });

    if (candidates.length === 0) {
      return { pitched: false, reason: "no-candidates-pass-gate" };
    }

    // Step 2: Check pitch history
    const candidate = await step.run("check-pitch-history", async () => {
      const redis = getRedis();
      const historyRaw = await redis.get(PITCH_HISTORY_KEY);
      const history: PitchRecord[] = historyRaw ? (JSON.parse(historyRaw) as PitchRecord[]) : [];
      const now = Date.now();
      const today = new Date().toISOString().slice(0, 10);

      // Already pitched today?
      const pitchedToday = history.some((h) => h.pitched_at.startsWith(today));
      if (pitchedToday) return null;

      // Find first candidate not recently rejected
      for (const c of candidates) {
        const recentRejection = history.some(
          (h) =>
            h.adr_number === c.number &&
            h.response === "rejected" &&
            now - new Date(h.pitched_at).getTime() < SEVEN_DAYS_MS,
        );
        if (!recentRejection) return c;
      }
      return null;
    });

    if (!candidate) {
      return { pitched: false, reason: "already-pitched-today-or-all-recently-rejected" };
    }

    // Step 3: Send pitch to Telegram
    await step.run("send-pitch", async () => {
      const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
      const TELEGRAM_CHAT_ID = process.env.TELEGRAM_USER_ID;
      if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.warn("[adr-daily-pitch] missing TELEGRAM_BOT_TOKEN or TELEGRAM_USER_ID");
        return { sent: false, reason: "missing-telegram-config" };
      }

      const text = [
        `🎯 <b>Work Pitch: ADR-${candidate.number}</b>`,
        "",
        `<b>${candidate.title}</b>`,
        `Score: ${candidate.score}/100 (${candidate.band})`,
        `N:${candidate.need} R:${candidate.readiness} C:${candidate.confidence} ✨:${candidate.novelty}`,
        "",
        candidate.rationale || "<i>No rationale recorded</i>",
        "",
        `<i>Status: ${candidate.status} | Pitched: ${new Date().toISOString().slice(0, 10)}</i>`,
      ].join("\n");

      const response = await fetch(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: TELEGRAM_CHAT_ID,
            text,
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "👍 Ship it", callback_data: `pitch:approve:${candidate.number}` },
                  { text: "👎 Not now", callback_data: `pitch:reject:${candidate.number}` },
                ],
              ],
            },
          }),
        },
      );

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        console.error("[adr-daily-pitch] telegram send failed", { status: response.status, body });
        return { sent: false, reason: "telegram-send-failed", status: response.status };
      }

      // Record in pitch history
      const redis = getRedis();
      const historyRaw = await redis.get(PITCH_HISTORY_KEY);
      const history: PitchRecord[] = historyRaw ? (JSON.parse(historyRaw) as PitchRecord[]) : [];
      history.push({
        adr_number: candidate.number,
        pitched_at: new Date().toISOString(),
        response: "pending",
      });
      // Keep last 100 entries
      const trimmed = history.slice(-100);
      await redis.set(PITCH_HISTORY_KEY, JSON.stringify(trimmed));

      return { sent: true };
    });

    // Step 4: OTEL
    await step.run("emit-otel", async () => {
      await emitOtelEvent({
        level: "info",
        source: "worker",
        component: "adr-pitch",
        action: "adr.pitch.sent",
        success: true,
        metadata: {
          adr_number: candidate.number,
          title: candidate.title,
          score: candidate.score,
          band: candidate.band,
          need: candidate.need,
          readiness: candidate.readiness,
          confidence: candidate.confidence,
          novelty: candidate.novelty,
        },
      });
    });

    return {
      pitched: true,
      adr_number: candidate.number,
      title: candidate.title,
      score: candidate.score,
    };
  },
);

async function editTelegramMessage(messageId: number, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_USER_ID ?? process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId || !messageId) return;

  await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [] },
    }),
  }).catch(() => {});
}

export const adrPitchApproved = inngest.createFunction(
  {
    id: "adr-pitch-approved",
    name: "ADR: Pitch Approved",
    retries: 2,
  },
  { event: "adr/pitch.approved" },
  async ({ event, step }) => {
    const adr_number = event.data.adr_number as string | number;
    const messageId = event.data.telegram_message_id as number | undefined;
    const normalized = String(adr_number).padStart(4, "0");

    const updated = await step.run("update-redis", async () => {
      return updatePitchHistoryResponse(adr_number, "approved");
    });

    await step.run("edit-telegram-message", async () => {
      if (messageId) {
        const redis = getRedis();
        const historyRaw = await redis.get(PITCH_HISTORY_KEY);
        const history: PitchRecord[] = historyRaw ? (JSON.parse(historyRaw) as PitchRecord[]) : [];
        const pitch = history.find(h => String(h.adr_number).padStart(4, "0") === normalized);
        const originalText = pitch ? `📋 <b>ADR-${normalized}</b>` : `ADR-${normalized}`;
        await editTelegramMessage(messageId, `${originalText}\n\n✅ Approved — queued for work`);
      }
    });

    return { updated, adr_number: normalized };
  },
);

export const adrPitchRejected = inngest.createFunction(
  {
    id: "adr-pitch-rejected",
    name: "ADR: Pitch Rejected",
    retries: 2,
  },
  { event: "adr/pitch.rejected" },
  async ({ event, step }) => {
    const adr_number = event.data.adr_number as string | number;
    const messageId = event.data.telegram_message_id as number | undefined;
    const normalized = String(adr_number).padStart(4, "0");

    const updated = await step.run("update-redis", async () => {
      return updatePitchHistoryResponse(adr_number, "rejected");
    });

    await step.run("edit-telegram-message", async () => {
      if (messageId) {
        await editTelegramMessage(messageId, `📋 <b>ADR-${normalized}</b>\n\n❌ Rejected — cooling off 7 days`);
      }
    });

    return { updated, adr_number: normalized };
  },
);
