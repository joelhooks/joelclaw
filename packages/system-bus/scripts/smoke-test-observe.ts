import { QdrantClient } from "@qdrant/js-client-rest";
import Redis from "ioredis";

const DEFAULT_EVENT_KEY = "37aa349b89692d657d276a40e0e47a15";
const INNGEST_BASE_URL = "http://localhost:8288";
const QDRANT_COLLECTION = "memory_observations";
const WAIT_MS = 30_000;

type SmokeEventData = {
  sessionId: string;
  dedupeKey: string;
  trigger: "compaction";
  messages: string;
  messageCount: number;
  tokensBefore: number;
  filesRead: string[];
  filesModified: string[];
  capturedAt: string;
  schemaVersion: 1;
};

type CheckResult = {
  pass: boolean;
  detail: string;
};

function getTodayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function buildSmokeEventData(nowMs: number): SmokeEventData {
  return {
    sessionId: `smoke-test-${nowMs}`,
    dedupeKey: `smoke-${nowMs}`,
    trigger: "compaction",
    messages: "User: Hello\nAssistant: Hi there, this is a smoke test session.",
    messageCount: 2,
    tokensBefore: 100,
    filesRead: [],
    filesModified: [],
    capturedAt: new Date().toISOString(),
    schemaVersion: 1,
  };
}

async function sendSmokeEvent(eventKey: string, data: SmokeEventData): Promise<CheckResult> {
  const url = `${INNGEST_BASE_URL}/e/${eventKey}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify([
      {
        name: "memory/session.compaction.pending",
        data,
      },
    ]),
  });

  if (!response.ok) {
    return {
      pass: false,
      detail: `Inngest returned ${response.status}`,
    };
  }

  return {
    pass: true,
    detail: `event sent for session ${data.sessionId}`,
  };
}

async function checkQdrantForSession(sessionId: string): Promise<CheckResult> {
  const qdrantClient = new QdrantClient({
    host: "localhost",
    port: 6333,
  });

  const result = await qdrantClient.scroll(QDRANT_COLLECTION, {
    limit: 10,
    with_payload: true,
    with_vector: false,
    filter: {
      must: [
        {
          key: "session_id",
          match: {
            value: sessionId,
          },
        },
      ],
    },
  });

  const points = Array.isArray(result.points) ? result.points : [];
  const hasMatch = points.some((point) => {
    const payload = point.payload as Record<string, unknown> | undefined;
    return payload?.session_id === sessionId;
  });

  return hasMatch
    ? {
        pass: true,
        detail: `found ${points.length} point(s)`,
      }
    : {
        pass: false,
        detail: "no matching points found",
      };
}

async function checkRedisLatestKey(date: string): Promise<CheckResult> {
  const redis = new Redis({
    host: process.env.REDIS_HOST ?? "localhost",
    port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
    lazyConnect: true,
  });

  const key = `memory:latest:${date}`;
  try {
    const value = await redis.get(key);
    if (value) {
      return {
        pass: true,
        detail: `key exists (${key})`,
      };
    }

    return {
      pass: false,
      detail: `missing key (${key})`,
    };
  } finally {
    try {
      await redis.quit();
    } catch {
      redis.disconnect();
    }
  }
}

function printResult(label: string, result: CheckResult) {
  const status = result.pass ? "PASS" : "FAIL";
  console.log(`${status}: ${label} - ${result.detail}`);
}

export async function runSmokeTest(): Promise<void> {
  const nowMs = Date.now();
  const eventKey = process.env.INNGEST_EVENT_KEY ?? DEFAULT_EVENT_KEY;
  const eventData = buildSmokeEventData(nowMs);

  try {
    const sendResult = await sendSmokeEvent(eventKey, eventData);
    printResult("Inngest event send", sendResult);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    printResult("Inngest event send", { pass: false, detail: message });
  }

  console.log(`Waiting ${WAIT_MS / 1000} seconds for processing...`);
  await new Promise<void>((resolve) => setTimeout(resolve, WAIT_MS));

  try {
    const qdrantResult = await checkQdrantForSession(eventData.sessionId);
    printResult("Qdrant observation lookup", qdrantResult);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    printResult("Qdrant observation lookup", { pass: false, detail: message });
  }

  try {
    const redisResult = await checkRedisLatestKey(getTodayIsoDate());
    printResult("Redis memory:latest check", redisResult);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    printResult("Redis memory:latest check", { pass: false, detail: message });
  }
}

export const main = runSmokeTest;
export default runSmokeTest;

if (import.meta.main) {
  await runSmokeTest();
}
