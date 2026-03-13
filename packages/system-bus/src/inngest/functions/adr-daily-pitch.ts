import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Redis from "ioredis";
import { getRedisPort } from "../../lib/redis";
import { bulkImport, SYSTEM_KNOWLEDGE_COLLECTION, search } from "../../lib/typesense";
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
    let candidates = await step.run("rank-open-adrs", () => {
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
          // ADR-0183 rubric gates:
          // - readiness >= 3 (hard gate: don't start if blocked/vague)
          // - confidence >= 3 (hard gate: need spike first if lower)
          // - band = do-now or next (score >= 60)
          // Score drives sort order — highest value pitches first
          const pitchableBands = new Set(["do-now", "next"]);
          if (fm && fm.readiness >= 3 && fm.confidence >= 3 && pitchableBands.has(fm.band)) {
            scored.push(fm);
          }
        } catch {
          // skip unreadable ADRs
        }
      }

      // Match joelclaw.com/adrs sort: band rank first, then score, then need
      const bandRank: Record<string, number> = { "do-now": 0, "next": 1, "de-risk": 2, "park": 3 };
      scored.sort((a, b) => {
        const aRank = bandRank[a.band] ?? 99;
        const bRank = bandRank[b.band] ?? 99;
        if (aRank !== bRank) return aRank - bRank;
        if (a.score !== b.score) return b.score - a.score;
        return b.need - a.need;
      });
      return scored;
    });

    // Sync scored ADRs to system_knowledge with rubric data (ADR-0199)
    await step.run("sync-adrs-to-knowledge", async () => {
      if (candidates.length === 0) return { synced: 0 };
      const now = Math.floor(Date.now() / 1000);
      const docs = candidates.map((c) => ({
        id: `adr:${c.number}`,
        type: "adr",
        title: `ADR-${c.number}: ${c.title}`,
        content: (() => {
          try {
            const filePath = join(VAULT_PATH, "docs/decisions", `${c.number}-${c.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`);
            return readFileSync(filePath, "utf-8").slice(0, 8000);
          } catch {
            return `ADR-${c.number}: ${c.title}. Band: ${c.band}, Score: ${c.score}, NRC: ${c.need}/${c.readiness}/${c.confidence}`;
          }
        })(),
        status: c.band,
        score: c.score,
        tags: ["adr", c.band, `score-${c.score}`],
        created_at: now,
      }));
      try {
        const result = await bulkImport(SYSTEM_KNOWLEDGE_COLLECTION, docs);
        return { synced: result.success, errors: result.errors };
      } catch {
        return { synced: 0, error: "typesense unavailable" };
      }
    });

    if (candidates.length === 0) {
      return { pitched: false, reason: "no-candidates-pass-gate" };
    }

    // Step 1b: Exclude failed targets (ADR-0199)
    candidates = await step.run("check-failed-targets", async () => {
      try {
        const result = await search({
          collection: SYSTEM_KNOWLEDGE_COLLECTION,
          q: "*",
          query_by: "title,content",
          filter_by: "type:=failed_target",
          per_page: 100,
        });
        const failedAdrs = new Set<string>();
        for (const hit of result.hits ?? []) {
          const doc = hit.document as { content?: string; title?: string };
          const text = `${doc.title ?? ""} ${doc.content ?? ""}`;
          const matches = text.matchAll(/ADR[- ]?(\d{4})/gi);
          for (const m of matches) failedAdrs.add(m[1]!);
        }
        if (failedAdrs.size > 0) {
          console.log(`[pitch] excluding ${failedAdrs.size} failed target ADRs: ${[...failedAdrs].join(", ")}`);
        }
        return candidates.filter((c) => !failedAdrs.has(c.number));
      } catch {
        return candidates; // graceful
      }
    });

    if (candidates.length === 0) {
      return { pitched: false, reason: "all-candidates-are-failed-targets" };
    }

    // Step 1c: Gather mise brief (ADR-0199)
    const miseBrief = await step.run("gather-mise-brief", async () => {
      const brief: {
        recentRetros: Array<{ id: string; title: string }>;
        failedTargets: number;
        recentLessons: string[];
        activeLoops: number;
      } = { recentRetros: [], failedTargets: 0, recentLessons: [], activeLoops: 0 };

      try {
        // Recent retros
        const retros = await search({
          collection: SYSTEM_KNOWLEDGE_COLLECTION,
          q: "*",
          query_by: "title,content",
          filter_by: "type:=retro",
          sort_by: "created_at:desc",
          per_page: 5,
        });
        brief.recentRetros = (retros.hits ?? []).map((h) => {
          const d = h.document as { id?: string; title?: string };
          return { id: d.id ?? "", title: d.title ?? "" };
        });

        // Failed target count
        const ft = await search({
          collection: SYSTEM_KNOWLEDGE_COLLECTION,
          q: "*",
          query_by: "title,content",
          filter_by: "type:=failed_target",
          per_page: 0,
        });
        brief.failedTargets = ft.found ?? 0;

        // Recent lessons
        const lessons = await search({
          collection: SYSTEM_KNOWLEDGE_COLLECTION,
          q: "*",
          query_by: "title,content",
          filter_by: "type:=lesson",
          sort_by: "created_at:desc",
          per_page: 5,
        });
        brief.recentLessons = (lessons.hits ?? []).map((h) => {
          const d = h.document as { title?: string };
          return d.title ?? "";
        });

        // Active loops
        const redis = getRedis();
        const loopKeys = await redis.keys("loop:*:prd");
        brief.activeLoops = loopKeys.length;
      } catch { /* graceful */ }

      console.log(`[pitch] mise brief: ${brief.recentRetros.length} retros, ${brief.failedTargets} failed targets, ${brief.recentLessons.length} lessons, ${brief.activeLoops} active loops`);
      return brief;
    });

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
        "",
        `<code>mise: ${miseBrief.recentRetros.length} retros | ${miseBrief.failedTargets} failed | ${miseBrief.activeLoops} active loops</code>`,
        ...(miseBrief.recentLessons.length > 0
          ? [`<i>Recent: ${miseBrief.recentLessons.slice(0, 2).join("; ").slice(0, 100)}</i>`]
          : []),
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
        action: "pitch.sent",
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
