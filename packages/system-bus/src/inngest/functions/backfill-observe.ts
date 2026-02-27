import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import Redis from "ioredis";
import { inngest } from "../client";

const PI_SESSIONS_DIR =
  process.env.HOME + "/.pi/agent/sessions/--Users-joel--";

const REDIS_KEY = "memory:backfill:processed"; // SET of processed session IDs
const REDIS_PROGRESS_KEY = "memory:backfill:progress"; // HASH: total, processed, skipped, last_session

let redis: Redis | null = null;
function getRedis(): Redis {
  if (!redis) redis = new Redis({ host: "localhost", port: 6379 });
  return redis;
}

/**
 * Backfill observations from historical pi session transcripts.
 *
 * Resumable: tracks processed sessions in Redis SET — restarts skip already-done.
 * Idempotent: same session ID never sent twice (SISMEMBER check + observe.ts SETNX dedupe).
 * Throttled: sleeps between events so observe + embedding pipeline isn't overwhelmed.
 *
 * Cancel: send memory/backfill.cancelled event.
 * Monitor: HGETALL memory:backfill:progress
 */
export const backfillObserve = inngest.createFunction(
  {
    id: "memory/backfill-observe",
    name: "Backfill Observations from Transcripts",
    retries: 2,
    cancelOn: [{ event: "memory/backfill.cancelled" }],
    singleton: { key: '"backfill"', mode: "skip" },
  },
  { event: "memory/backfill.requested" },
  async ({ event, step }) => {
    const minMessages = event.data.minMessages ?? 20;
    const sleepSeconds = event.data.sleepSeconds ?? 30;
    const maxSessions = event.data.maxSessions ?? 100;

    // Step 1: Discover qualifying sessions
    const sessions = await step.run("discover-sessions", () => {
      const files = readdirSync(PI_SESSIONS_DIR)
        .filter((f) => f.endsWith(".jsonl"))
        .sort();

      const results: {
        file: string;
        sessionId: string;
        timestamp: string;
        messageCount: number;
        userMessageCount: number;
      }[] = [];

      for (const file of files) {
        const filePath = join(PI_SESSIONS_DIR, file);
        const lines = readFileSync(filePath, "utf-8")
          .split("\n")
          .filter((l) => l.trim());

        let sessionId = "";
        let timestamp = "";
        let msgCount = 0;
        let userCount = 0;

        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.type === "session") {
              sessionId = entry.id;
              timestamp = entry.timestamp;
            }
            if (entry.type === "message" && entry.message) {
              const role = entry.message.role;
              let hasContent = false;
              if (typeof entry.message.content === "string") {
                hasContent = entry.message.content.length > 0;
              } else if (Array.isArray(entry.message.content)) {
                hasContent = entry.message.content.some(
                  (c: any) => c.type === "text" && c.text?.length > 0
                );
              }
              if (hasContent && (role === "user" || role === "assistant")) {
                msgCount++;
                if (role === "user") userCount++;
              }
            }
          } catch {
            // skip malformed
          }
        }

        if (msgCount >= minMessages && userCount >= 2) {
          results.push({
            file,
            sessionId: sessionId || basename(file, ".jsonl"),
            timestamp,
            messageCount: msgCount,
            userMessageCount: userCount,
          });
        }
      }

      return {
        totalFiles: files.length,
        qualifying: results.length,
        sessions: results.slice(0, maxSessions),
      };
    });

    // Step 2: Filter already-processed (resumability)
    const toProcess = await step.run("filter-processed", async () => {
      const r = getRedis();
      const remaining: typeof sessions.sessions = [];
      for (const s of sessions.sessions) {
        const done = await r.sismember(REDIS_KEY, s.sessionId);
        if (!done) remaining.push(s);
      }
      // Init progress tracking
      await r.hset(REDIS_PROGRESS_KEY, {
        total: String(sessions.qualifying),
        already_done: String(sessions.sessions.length - remaining.length),
        remaining: String(remaining.length),
        started_at: new Date().toISOString(),
      });
      return remaining;
    });

    if (toProcess.length === 0) {
      return {
        status: "complete",
        message: "All qualifying sessions already processed",
        totalFiles: sessions.totalFiles,
        qualifying: sessions.qualifying,
        alreadyDone: sessions.sessions.length,
      };
    }

    // Step 3: Process each session
    let processed = 0;
    let skipped = 0;

    for (const session of toProcess) {
      const sid = session.sessionId.slice(0, 8);

      // Double-check idempotency (in case of concurrent runs)
      const alreadyDone = await step.run(`check-${sid}`, async () => {
        return !!(await getRedis().sismember(REDIS_KEY, session.sessionId));
      });

      if (alreadyDone) {
        skipped++;
        continue;
      }

      // Read and format messages
      const messageData = await step.run(`read-${sid}`, () => {
        const filePath = join(PI_SESSIONS_DIR, session.file);
        const lines = readFileSync(filePath, "utf-8")
          .split("\n")
          .filter((l) => l.trim());

        const messages: { role: string; content: string }[] = [];
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.type === "message" && entry.message) {
              const role = entry.message.role;
              let content = "";
              if (typeof entry.message.content === "string") {
                content = entry.message.content;
              } else if (Array.isArray(entry.message.content)) {
                content = entry.message.content
                  .filter((c: any) => c.type === "text")
                  .map((c: any) => c.text)
                  .join("\n");
              }
              if (content && (role === "user" || role === "assistant")) {
                messages.push({ role, content });
              }
            }
          } catch {
            // skip
          }
        }

        // Truncate to ~8000 chars to keep LLM calls manageable
        let formatted = "";
        for (const m of messages) {
          const line = `${m.role === "user" ? "User" : "Assistant"}: ${m.content}\n`;
          if (formatted.length + line.length > 8000) break;
          formatted += line;
        }

        return {
          messages: formatted,
          userMessageCount: messages.filter((m) => m.role === "user").length,
          messageCount: messages.length,
        };
      });

      if (!messageData.messages || messageData.messages.length < 100) {
        // Mark as processed anyway so we don't retry empty sessions
        await step.run(`mark-skip-${sid}`, async () => {
          await getRedis().sadd(REDIS_KEY, session.sessionId);
        });
        skipped++;
        continue;
      }

      const dedupeKey = createHash("sha256")
        .update(session.sessionId + "-backfill")
        .digest("hex");

      // Fire observe event
      await step.sendEvent(`emit-${sid}`, {
        name: "memory/session.ended",
        data: {
          sessionId: `backfill-${session.sessionId}`,
          dedupeKey,
          trigger: "backfill" as const,
          messages: messageData.messages,
          messageCount: messageData.messageCount,
          userMessageCount: messageData.userMessageCount,
          duration: 0,
          sessionName: `backfill-${session.file}`,
          filesRead: [],
          filesModified: [],
          capturedAt: session.timestamp || new Date().toISOString(),
          schemaVersion: 1 as const,
        },
      });

      // Mark processed in Redis
      await step.run(`mark-done-${sid}`, async () => {
        const r = getRedis();
        await r.sadd(REDIS_KEY, session.sessionId);
        await r.hset(REDIS_PROGRESS_KEY, {
          processed: String(processed + 1),
          skipped: String(skipped),
          last_session: session.sessionId,
          last_timestamp: session.timestamp,
          updated_at: new Date().toISOString(),
        });
      });

      processed++;

      // Throttle — let observe + embedding pipeline breathe
      if (processed < toProcess.length) {
        await step.sleep(`throttle-${sid}`, `${sleepSeconds}s`);
      }
    }

    // Final progress update
    await step.run("finalize", async () => {
      await getRedis().hset(REDIS_PROGRESS_KEY, {
        status: "complete",
        processed: String(processed),
        skipped: String(skipped),
        completed_at: new Date().toISOString(),
      });
    });

    return {
      status: "complete",
      totalFiles: sessions.totalFiles,
      qualifying: sessions.qualifying,
      processed,
      skipped,
      sleepBetween: `${sleepSeconds}s`,
    };
  }
);
