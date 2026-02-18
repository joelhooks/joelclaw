import { inngest } from "../client.ts";
import { NonRetriableError } from "inngest";
import { QdrantClient } from "@qdrant/js-client-rest";
import Redis from "ioredis";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseObserverOutput } from "./observe-parser";
import { OBSERVER_SYSTEM_PROMPT, OBSERVER_USER_PROMPT } from "./observe-prompt";
import { embedText } from "./embed";

type ObserveCompactionInput = {
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

type ObserveEndedInput = {
  sessionId: string;
  dedupeKey: string;
  trigger: "shutdown";
  messages: string;
  messageCount: number;
  userMessageCount: number;
  duration: number;
  sessionName?: string;
  filesRead: string[];
  filesModified: string[];
  capturedAt: string;
  schemaVersion: 1;
};

type ObserveInput = ObserveCompactionInput | ObserveEndedInput;
type QdrantPointPayload = {
  session_id: string;
  timestamp: string;
  observation_type: string;
  observation: string;
};

const QDRANT_COLLECTION = "memory_observations";
const QDRANT_VECTOR_DIMENSIONS = 768;
const QDRANT_ZERO_VECTOR = Array.from({ length: QDRANT_VECTOR_DIMENSIONS }, () => 0);
let redisClient: Redis | null = null;

function getRedisClient(): Redis {
  if (!redisClient) {
    const isTestEnv = process.env.NODE_ENV === "test" || process.env.BUN_TEST === "1";
    redisClient = new Redis({
      host: process.env.REDIS_HOST ?? "localhost",
      port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
      lazyConnect: true,
      retryStrategy: isTestEnv ? () => null : undefined,
    });
    redisClient.on("error", () => {});
  }
  return redisClient;
}

function isoDateFromTimestamp(value: string | undefined): string {
  if (typeof value === "string") {
    const date = value.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return date;
    }
  }
  return new Date().toISOString().slice(0, 10);
}

function createObservationItems(parsedObservations: {
  observations: string;
  segments: unknown[];
}) {
  const items: Array<{ observationType: string; observation: string }> = [];

  for (const rawSegment of parsedObservations.segments) {
    const segment = rawSegment as { narrative?: unknown; facts?: unknown };
    const narrative = typeof segment.narrative === "string" ? segment.narrative.trim() : "";
    if (narrative.length > 0) {
      items.push({
        observationType: "segment_narrative",
        observation: narrative,
      });
    }

    const facts = Array.isArray(segment.facts) ? segment.facts : [];
    for (const fact of facts) {
      if (typeof fact !== "string") {
        continue;
      }
      const trimmedFact = fact.trim();
      if (trimmedFact.length > 0) {
        items.push({
          observationType: "segment_fact",
          observation: trimmedFact,
        });
      }
    }
  }

  if (items.length > 0) {
    return items;
  }

  const fallbackObservation = parsedObservations.observations.trim();
  if (fallbackObservation.length > 0) {
    items.push({
      observationType: "observation_text",
      observation: fallbackObservation,
    });
  }

  return items;
}

function readShellText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (value == null) return "";
  return String(value);
}

function assertRequiredStringField(
  payload: Record<string, unknown>,
  fieldName: "sessionId" | "dedupeKey" | "trigger" | "messages"
) {
  const value = payload[fieldName];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new NonRetriableError(`Missing required session field: ${fieldName}`);
  }
}

function validateObserveInput(eventName: string, data: unknown): ObserveInput {
  if (!data || typeof data !== "object") {
    throw new Error("Invalid event data: expected object payload");
  }

  const payload = data as Record<string, unknown>;
  assertRequiredStringField(payload, "sessionId");
  assertRequiredStringField(payload, "dedupeKey");
  assertRequiredStringField(payload, "trigger");
  assertRequiredStringField(payload, "messages");

  if (eventName === "memory/session.compaction.pending" && payload.trigger !== "compaction") {
    throw new Error("Invalid trigger for compaction event; expected 'compaction'");
  }

  if (eventName === "memory/session.ended" && payload.trigger !== "shutdown") {
    throw new Error("Invalid trigger for ended event; expected 'shutdown'");
  }

  if (payload.trigger !== "compaction" && payload.trigger !== "shutdown") {
    throw new Error(`Invalid trigger value: ${payload.trigger}`);
  }

  return payload as ObserveInput;
}

export const observeSessionFunction = inngest.createFunction(
  {
    id: "memory/observe-session",
    name: "Observe Session",
    throttle: { limit: 4, period: "60s" },
  },
  [
    { event: "memory/session.compaction.pending" },
    { event: "memory/session.ended" },
  ],
  async ({ event, step }) => {
    const validatedInput = await step.run("validate-input", async () =>
      validateObserveInput(event.name, event.data)
    );

    // Dedupe guard — prevent Inngest retries from re-processing
    const dedupeResult = await step.run("dedupe-check", async () => {
      const redis = getRedisClient();
      const result = await redis.set(
        `memory:observe:lock:${validatedInput.dedupeKey}`,
        "1",
        "EX",
        3600,
        "NX"
      );
      if (result === null) {
        return { dedupe: true, dedupeKey: validatedInput.dedupeKey };
      }
      return { dedupe: false, dedupeKey: validatedInput.dedupeKey };
    });

    if (dedupeResult.dedupe) {
      return {
        status: "deduplicated",
        sessionId: validatedInput.sessionId,
        dedupeKey: validatedInput.dedupeKey,
      };
    }

    const llmOutput = await step.run("call-observer-llm", async () => {
      const sessionName =
        "sessionName" in validatedInput ? validatedInput.sessionName : undefined;
      const userPrompt = OBSERVER_USER_PROMPT(
        validatedInput.messages,
        validatedInput.trigger,
        sessionName
      );
      const promptWithSessionContext = `${userPrompt}

Session context:
- sessionId: ${validatedInput.sessionId}
- dedupeKey: ${validatedInput.dedupeKey}`;

      try {
        const result = await Bun.$`pi --no-tools --no-session --print --mode text --system-prompt ${OBSERVER_SYSTEM_PROMPT} ${promptWithSessionContext}`
          .quiet()
          .nothrow();

        const stdout = readShellText(result.stdout);
        const stderr = readShellText(result.stderr);

        if (result.exitCode !== 0) {
          throw new Error(
            `Observer LLM subprocess failed with exit code ${result.exitCode}${
              stderr ? `: ${stderr}` : ""
            }`
          );
        }

        return stdout;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to run observer LLM subprocess: ${message}`);
      }

    });

    const parsedObservations = await step.run(
      "parse-observations",
      async () => {
        try {
          const parsed = parseObserverOutput(llmOutput);
          const facts = parsed.segments
            .flatMap((segment) => segment.facts)
            .map((fact) => fact.trim())
            .filter((fact) => fact.length > 0);
          const concepts = [
            ...new Set(
              [parsed.currentTask, ...parsed.segments.map((segment) => segment.narrative)]
                .map((concept) => (concept ?? "").trim())
                .filter((concept) => concept.length > 0)
            ),
          ];

          return {
            ...parsed,
            concepts,
            facts,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            observations: llmOutput,
            segments: [],
            currentTask: null,
            suggestedResponse: null,
            parsed: false,
            concepts: [],
            facts: [],
            error: message,
          };
        }
      }
    );

    // Append to daily log — durable fallback even if Redis/Qdrant are down
    const dailyLogResult = await step.run("append-daily-log", async () => {
      const date = isoDateFromTimestamp(validatedInput.capturedAt);
      const time = validatedInput.capturedAt
        ? new Date(validatedInput.capturedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })
        : "??:??";
      const dailyLogPath = join(
        process.env.HOME || "/Users/joel",
        ".joelclaw", "workspace", "memory", `${date}.md`
      );
      const sessionMarker = `### 🔭 Observations (session: ${validatedInput.sessionId}`;

      try {
        const existingDailyLog = readFileSync(dailyLogPath, "utf-8");
        if (existingDailyLog.includes(sessionMarker)) {
          return { appended: false, path: dailyLogPath, reason: "duplicate" };
        }
      } catch (error) {
        const code =
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof (error as { code?: unknown }).code === "string"
            ? (error as { code: string }).code
            : null;
        if (code !== "ENOENT") {
          const message = error instanceof Error ? error.message : String(error);
          return { appended: false, path: dailyLogPath, error: message };
        }
      }

      const lines: string[] = [
        `\n### 🔭 Observations (session: ${validatedInput.sessionId}, ${time})`,
        `\n**Trigger**: ${validatedInput.trigger}`,
        `**Files**: ${validatedInput.filesModified.length} modified, ${validatedInput.filesRead.length} read\n`,
      ];

      if (parsedObservations.segments && parsedObservations.segments.length > 0) {
        for (const seg of parsedObservations.segments) {
          const segment = seg as { narrative?: string; facts?: string[] };
          if (segment.narrative) {
            lines.push(`#### ${segment.narrative}\n`);
          }
          if (Array.isArray(segment.facts)) {
            for (const fact of segment.facts) {
              lines.push(`${fact}`);
            }
            lines.push("");
          }
        }
      } else if (parsedObservations.observations) {
        lines.push(parsedObservations.observations);
        lines.push("");
      }

      if (parsedObservations.currentTask) {
        lines.push(`**Current task**: ${parsedObservations.currentTask}\n`);
      }

      const markdown = lines.join("\n");
      try {
        mkdirSync(join(process.env.HOME || "/Users/joel", ".joelclaw", "workspace", "memory"), { recursive: true });
        appendFileSync(dailyLogPath, markdown, "utf-8");
        return { appended: true, path: dailyLogPath, length: markdown.length };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { appended: false, path: dailyLogPath, error: message };
      }
    });

    const qdrantCollectionResult = await step.run(
      "ensure-qdrant-collection",
      async () => {
        try {
          const qdrantClient = new QdrantClient({
            host: "localhost",
            port: 6333,
          });

          const collections = await qdrantClient.getCollections();
          const exists = collections.collections.some(
            (collection: { name: string }) => collection.name === QDRANT_COLLECTION
          );

          if (exists) {
            return {
              exists: true,
              created: false,
            };
          }

          await qdrantClient.createCollection(QDRANT_COLLECTION, {
            vectors: {
              size: QDRANT_VECTOR_DIMENSIONS,
              distance: "Cosine",
            },
          });

          return {
            exists: false,
            created: true,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            exists: false,
            created: false,
            error: message,
          };
        }
      }
    );

    // Generate real embeddings via generic embedding function (all-mpnet-base-v2, 768-dim)
    const observationItemsForEmbed = createObservationItems(parsedObservations);
    let embeddingVectors: { id: string; vector: number[] }[] = [];

    if (observationItemsForEmbed.length > 0) {
      const result = await step.invoke("generate-embeddings", {
        function: embedText,
        data: {
          texts: observationItemsForEmbed.map((item, i) => ({
            id: String(i),
            text: item.observation,
          })),
        },
      });
      if (result?.vectors) {
        embeddingVectors = (result.vectors as { id: string; vector: number[] }[]).filter(
          (v): v is { id: string; vector: number[] } => v != null
        );
      }
    }

    // Build a lookup: id → vector
    const vectorMap = new Map<string, number[]>();
    for (const v of embeddingVectors) {
      vectorMap.set(v.id, v.vector);
    }

    const qdrantStoreResult = await step.run("store-to-qdrant", async () => {
      try {
        const qdrantClient = new QdrantClient({
          host: "localhost",
          port: 6333,
        });

        const observationItems = createObservationItems(parsedObservations);
        if (observationItems.length === 0) {
          return {
            stored: true,
            count: 0,
            hasRealVectors: false,
            sourceSessionId: validatedInput.sessionId,
          };
        }

        const timestamp = validatedInput.capturedAt ?? new Date().toISOString();
        const points = observationItems.map((item, index) => ({
          id: randomUUID(),
          vector: vectorMap.get(String(index)) ?? QDRANT_ZERO_VECTOR,
          payload: {
            session_id: validatedInput.sessionId,
            timestamp,
            observation_type: item.observationType,
            observation: item.observation,
          } satisfies QdrantPointPayload,
        }));

        const hasReal = points.some(
          (p) => p.vector !== QDRANT_ZERO_VECTOR
        );

        await qdrantClient.upsert(QDRANT_COLLECTION, {
          wait: true,
          points,
        });

        return {
          stored: true,
          count: points.length,
          hasRealVectors: hasReal,
          sourceSessionId: validatedInput.sessionId,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          stored: false,
          hasRealVectors: false,
          sourceSessionId: validatedInput.sessionId,
          error: message,
        };
      }
    });

    const observationItems = createObservationItems(parsedObservations);
    const observationCount = observationItems.length;
    const observationSummary =
      parsedObservations.observations.trim() ||
      observationItems.map((item) => item.observation).join("\n");
    const capturedAt = validatedInput.capturedAt ?? new Date().toISOString();
    const date = isoDateFromTimestamp(capturedAt);
    const redisKey = `memory:latest:${date}`;
    const totalTokens =
      validatedInput.trigger === "compaction" ? validatedInput.tokensBefore : validatedInput.messageCount;

    const redisStateResult = await step.run("update-redis-state", async () => {
      const redisPayload = {
        summary: observationSummary,
        metadata: {
          session_id: validatedInput.sessionId,
          dedupe_key: validatedInput.dedupeKey,
          trigger: validatedInput.trigger,
          observation_count: observationCount,
          message_count: validatedInput.messageCount,
          captured_at: capturedAt,
          date,
          qdrant_collection: qdrantCollectionResult,
          qdrant: qdrantStoreResult,
        },
      };

      try {
        const redis = getRedisClient();
        const payloadJson = JSON.stringify(redisPayload);
        // Latest observation (overwrite) for quick lookup
        await redis.set(redisKey, payloadJson);
        // Ordered list (append) for Reflector to load all observations
        const listKey = `memory:observations:${date}`;
        const listLength = await redis.rpush(listKey, payloadJson);
        // 30-day TTL on the list
        await redis.expire(listKey, 30 * 24 * 60 * 60);
        return {
          updated: true,
          key: redisKey,
          listKey,
          listLength,
          observationCount,
          summaryLength: observationSummary.length,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          updated: false,
          key: redisKey,
          error: message,
          observationCount,
        };
      }
    });

    const accumulatedData = {
      date,
      totalTokens,
      observationCount,
      capturedAt,
    };

    const accumulatedEventPayload = {
      name: "memory/observations.accumulated" as const,
      data: accumulatedData,
    };

    const accumulatedEvent = await step.sendEvent("emit-accumulated", [accumulatedEventPayload])
      .then(() => ({
        emitted: true,
        name: accumulatedEventPayload.name,
        data: accumulatedEventPayload.data,
        observationCount,
        redisUpdated: redisStateResult,
      }))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        return {
          emitted: false,
          name: accumulatedEventPayload.name,
          data: accumulatedEventPayload.data,
          error: message,
          observationCount,
          redisUpdated: redisStateResult,
        };
      });

    return {
      sessionId: validatedInput.sessionId,
      accumulatedEvent,
    };
  }
);
