/**
 * Stale loop detection — check for stuck or long-running agent loops.
 * Only notifies gateway if a loop appears stuck (>2h, no progress).
 */

import { inngest } from "../client";
import { pushGatewayEvent } from "./agent-loop/utils";
import Redis from "ioredis";

const COOLDOWN_KEY = "loops:stale:last-check";
const COOLDOWN_TTL = 60 * 60; // 1 hour

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

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  return new Response(stream).text();
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object";
}

export const checkLoops = inngest.createFunction(
  {
    id: "check/stale-loops",
    concurrency: { limit: 1 },
    retries: 1,
  },
  { event: "loops/stale.check" },
  async ({ step }) => {
    // NOOP: cooldown
    const cooled = await step.run("check-cooldown", async () => {
      const redis = getRedis();
      return !!(await redis.get(COOLDOWN_KEY));
    });

    if (cooled) {
      return { status: "noop", reason: "cooldown active (1h)" };
    }

    // Check for running loops via joelclaw CLI
    const loops = await step.run("check-running-loops", async () => {
      const proc = Bun.spawn(["joelclaw", "loop", "status"], {
        env: { ...process.env, TERM: "dumb" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });

      const [stdout, , exitCode] = await Promise.all([
        readStream(proc.stdout),
        readStream(proc.stderr),
        proc.exited,
      ]);

      if (exitCode !== 0 || !stdout.trim()) return [];

      try {
        const parsed = JSON.parse(stdout.trim());
        if (!isRecord(parsed) || !parsed.ok) return [];
        const result = parsed.result;
        const active = isRecord(result) && Array.isArray(result.loops) ? result.loops : [];
        return active.filter(isRecord).map((l) => ({
          id: String(l.id ?? l.loopId ?? ""),
          startedAt: String(l.startedAt ?? l.started_at ?? ""),
          storiesTotal: Number(l.storiesTotal ?? l.total ?? 0),
          storiesDone: Number(l.storiesDone ?? l.done ?? l.completed ?? 0),
          status: String(l.status ?? "unknown"),
        }));
      } catch {
        return [];
      }
    });

    // Set cooldown
    await step.run("set-cooldown", async () => {
      const redis = getRedis();
      await redis.set(COOLDOWN_KEY, new Date().toISOString(), "EX", COOLDOWN_TTL);
    });

    // NOOP: no running loops
    if (loops.length === 0) {
      return { status: "noop", reason: "no active loops" };
    }

    // Check for stale loops (>2h old with no recent progress)
    const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
    const now = Date.now();
    const stale = loops.filter((l) => {
      if (!l.startedAt) return false;
      const started = new Date(l.startedAt).getTime();
      return !isNaN(started) && (now - started) > TWO_HOURS_MS;
    });

    // NOOP: loops are running but not stale yet
    if (stale.length === 0) {
      return { status: "noop", reason: "loops running, none stale", activeCount: loops.length };
    }

    // Alert: stale loops detected
    await step.run("notify-stale-loops", async () => {
      const lines = stale.map((l) => {
        const age = Math.round((now - new Date(l.startedAt).getTime()) / (60 * 1000));
        return `- **Loop ${l.id}**: ${l.storiesDone}/${l.storiesTotal} stories, running ${age}min`;
      });

      await pushGatewayEvent({
        type: "loops.stale.detected",
        source: "inngest/check-loops",
        payload: {
          prompt: [
            `## ⚠️ ${stale.length} Stale Loop${stale.length > 1 ? "s" : ""} Detected`,
            "",
            ...lines,
            "",
            "Check with `joelclaw loop status` or cancel with `joelclaw loop cancel <id>`.",
          ].join("\n"),
        },
      });
    });

    return { status: "stale-detected", staleCount: stale.length, activeCount: loops.length };
  }
);
