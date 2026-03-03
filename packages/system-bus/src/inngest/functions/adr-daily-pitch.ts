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
const MAX_PITCHES_PER_DAY = 3;
const REJECTION_BACKOFF_HOURS = 4; // back off 4h after a rejection before pitching again

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
    id: "adr-work-pitch",
    name: "ADR: Work Pitch (capacity-driven)",
    retries: 2,
  },
  [
    { event: "adr/pitch.requested" },          // manual trigger
    { event: "agent/loop.completed" },          // loop finished
    { event: "agent/loop.retro.completed" },    // retro finished
    { event: "system/agent.completed" },        // agent dispatch finished
  ],
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
          // Gate: high confidence, tractable scope
          // confidence >= 4 = we know what to build
          // readiness >= 3 = dependencies met, not blocked
          // Sorted by score, so highest-value work gets pitched first
          if (fm && fm.confidence >= 4 && fm.readiness >= 3) {
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

    // Step 2: Check pitch history — soft cap + rejection backoff
    const candidate = await step.run("check-pitch-history", async () => {
      const redis = getRedis();
      const historyRaw = await redis.get(PITCH_HISTORY_KEY);
      const history: PitchRecord[] = historyRaw ? (JSON.parse(historyRaw) as PitchRecord[]) : [];
      const now = Date.now();
      const today = new Date().toISOString().slice(0, 10);

      // Soft cap: max N pitches per day
      const pitchesToday = history.filter((h) => h.pitched_at.startsWith(today));
      if (pitchesToday.length >= MAX_PITCHES_PER_DAY) return null;

      // Any pending pitch? Don't pile on — wait for response
      const hasPending = history.some((h) => h.response === "pending");
      if (hasPending) return null;

      // Rejection backoff: if last pitch was rejected, wait before pitching again
      const lastRejection = [...history].reverse().find((h) => h.response === "rejected");
      if (lastRejection) {
        const timeSince = now - new Date(lastRejection.pitched_at).getTime();
        if (timeSince < REJECTION_BACKOFF_HOURS * 60 * 60 * 1000) return null;
      }

      // Find first candidate not rejected in last 7 days
      for (const c of candidates) {
        const recentRejection = history.some(
          (h) =>
            String(h.adr_number).padStart(4, "0") === c.number &&
            h.response === "rejected" &&
            now - new Date(h.pitched_at).getTime() < SEVEN_DAYS_MS,
        );
        if (!recentRejection) return c;
      }
      return null;
    });

    if (!candidate) {
      return { pitched: false, reason: "at-cap-or-pending-or-backoff-or-all-rejected" };
    }

    // Step 3: Send pitch via gateway channel interface
    await step.run("send-pitch", async () => {
      const text = [
        `🎯 **Work Pitch: ADR-${candidate.number}**`,
        "",
        `**${candidate.title}**`,
        `Score: ${candidate.score}/100 (${candidate.band})`,
        `N:${candidate.need} R:${candidate.readiness} C:${candidate.confidence} ✨:${candidate.novelty}`,
        "",
        candidate.rationale || "_No rationale recorded_",
        "",
        `_Status: ${candidate.status} | Pitched: ${new Date().toISOString().slice(0, 10)}_`,
      ].join("\n");

      // Emit event for gateway to deliver via channel interface
      await step.sendEvent("send-pitch-message", {
        name: "gateway/send.message",
        data: {
          channel: "telegram",
          text,
          inline_keyboard: [
            [
              { text: "👍 Ship it", callback_data: `pitch:approve:${candidate.number}` },
              { text: "👎 Not now", callback_data: `pitch:reject:${candidate.number}` },
            ],
          ],
        },
      });

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

    await step.sendEvent("notify-approved", {
      name: "gateway/send.message",
      data: {
        channel: "telegram",
        text: `📋 **ADR-${normalized}**\n\n✅ Approved — queued for work`,
        edit_message_id: messageId,
        remove_keyboard: true,
      },
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

    await step.sendEvent("notify-rejected", {
      name: "gateway/send.message",
      data: {
        channel: "telegram",
        text: `📋 **ADR-${normalized}**\n\n❌ Rejected — cooling off 7 days`,
        edit_message_id: messageId,
        remove_keyboard: true,
      },
    });

    return { updated, adr_number: normalized };
  },
);
