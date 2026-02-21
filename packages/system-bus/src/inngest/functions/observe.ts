// ADR-0067: Supersede pattern adapted from knowledge-graph by safatinaztepe (openclaw/skills, MIT).
// ADR-0082: Dual-write to Qdrant + Typesense during migration. Typesense will become sole store.
import { inngest } from "../client.ts";
import { NonRetriableError } from "inngest";
import { QdrantClient } from "@qdrant/js-client-rest";
import Redis from "ioredis";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseObserverOutput } from "./observe-parser";
import { OBSERVER_SYSTEM_PROMPT, OBSERVER_USER_PROMPT } from "./observe-prompt";
import { DEDUP_THRESHOLD } from "../../memory/retrieval";
import * as typesense from "../../lib/typesense";
import { emitOtelEvent } from "../../observability/emit";

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
  trigger: "shutdown" | "backfill";
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
type TypesenseObservationDoc = {
  id: string;
  session_id: string;
  observation: string;
  observation_type: string;
  source: string;
  timestamp: number;
  merged_count?: number;
  updated_at?: string;
  superseded_by?: string | null;
  supersedes?: string | null;
};

const QDRANT_COLLECTION = "memory_observations";
const QDRANT_HOST = process.env.QDRANT_HOST ?? "localhost";
const QDRANT_PORT = Number.parseInt(process.env.QDRANT_PORT ?? "6333", 10);
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
    redisClient.on("error", (err) => {
      console.error("[observe] Redis error:", err);
    });
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

function asFiniteNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function normalizeTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\\s]/gu, " ")
      .split(/\\s+/u)
      .filter((token) => token.length >= 3)
  );
}

function textSimilarity(a: string, b: string): number {
  const left = normalizeTokens(a);
  const right = normalizeTokens(b);
  if (left.size === 0 || right.size === 0) return 0;

  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }

  const union = left.size + right.size - intersection;
  if (union <= 0) return 0;
  return intersection / union;
}

function normalizeTypesenseObservationDoc(input: Record<string, unknown> | null | undefined): TypesenseObservationDoc | null {
  if (!input) return null;
  const id = typeof input.id === "string" ? input.id : null;
  const session_id = typeof input.session_id === "string" ? input.session_id : "unknown";
  const observation = typeof input.observation === "string" ? input.observation : "";
  const observation_type = typeof input.observation_type === "string" ? input.observation_type : "observation_text";
  const source = typeof input.source === "string" ? input.source : "unknown";
  const timestamp = asFiniteNumber(input.timestamp, Number.NaN);

  if (!id || observation.trim().length === 0 || !Number.isFinite(timestamp)) return null;

  const superseded_by =
    typeof input.superseded_by === "string"
      ? input.superseded_by
      : input.superseded_by === null
        ? null
        : undefined;
  const supersedes =
    typeof input.supersedes === "string"
      ? input.supersedes
      : input.supersedes === null
        ? null
        : undefined;

  return {
    id,
    session_id,
    observation,
    observation_type,
    source,
    timestamp,
    merged_count: asFiniteNumber(input.merged_count, 1),
    updated_at: typeof input.updated_at === "string" ? input.updated_at : undefined,
    superseded_by,
    supersedes,
  };
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

  if (
    eventName === "memory/session.ended" &&
    payload.trigger !== "shutdown" &&
    payload.trigger !== "backfill"
  ) {
    throw new Error("Invalid trigger for ended event; expected 'shutdown' or 'backfill'");
  }

  if (
    payload.trigger !== "compaction" &&
    payload.trigger !== "shutdown" &&
    payload.trigger !== "backfill"
  ) {
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
  async ({ event, step, ...rest }) => {
    const gateway = (rest as any).gateway as import("../middleware/gateway").GatewayContext | undefined;
    const validatedInput = await step.run("validate-input", async () =>
      validateObserveInput(event.name, event.data)
    );
    await step.run("otel-observe-start", async () => {
      await emitOtelEvent({
        level: "debug",
        source: "worker",
        component: "observe",
        action: "observe.started",
        success: true,
        metadata: {
          sessionId: validatedInput.sessionId,
          trigger: validatedInput.trigger,
          messageCount: validatedInput.messageCount,
          dedupeKey: validatedInput.dedupeKey,
        },
      });
    });

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
      await step.run("otel-observe-dedupe", async () => {
        await emitOtelEvent({
          level: "debug",
          source: "worker",
          component: "observe",
          action: "observe.deduplicated",
          success: true,
          metadata: {
            sessionId: validatedInput.sessionId,
            dedupeKey: validatedInput.dedupeKey,
          },
        });
      });
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
        const result = await Bun.$`pi --no-tools --no-session --no-extensions --print --mode text --model anthropic/claude-haiku --system-prompt ${OBSERVER_SYSTEM_PROMPT} ${promptWithSessionContext}`
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
            host: QDRANT_HOST,
            port: QDRANT_PORT,
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
              size: 768,
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

    // ADR-0082: Qdrant write disabled — all consumers migrated to Typesense
    const qdrantStoreResult = await step.run("store-to-qdrant", async () => {
      return {
        stored: false,
        disabled: true,
        hasRealVectors: false,
        reason: "ADR-0082 Typesense-only write path",
        sourceSessionId: validatedInput.sessionId,
      };
    });

    // ADR-0082: Typesense is now canonical memory store.
    const typesenseStoreResult = await step.run("store-to-typesense", async () => {
      try {
        const observationItems = createObservationItems(parsedObservations);
        if (observationItems.length === 0) {
          return { stored: true, count: 0 };
        }

        const timestampIso = validatedInput.capturedAt ?? new Date().toISOString();
        const timestampUnix = Math.floor(new Date(timestampIso).getTime() / 1000);
        const docs: TypesenseObservationDoc[] = [];
        let mergedCount = 0;

        for (const item of observationItems) {
          const similar = await typesense.search({
            collection: "memory_observations",
            q: item.observation,
            query_by: "observation",
            vector_query: "embedding:([], k:1, distance_threshold: 0.5)",
            per_page: 1,
            include_fields:
              "id,session_id,observation,observation_type,source,timestamp,merged_count,updated_at,superseded_by,supersedes",
          });
          const top = Array.isArray(similar.hits) ? similar.hits[0] : undefined;
          const existing = normalizeTypesenseObservationDoc(
            (top?.document ?? {}) as Record<string, unknown>
          );
          const isDedupMatch =
            !!existing &&
            !existing.superseded_by &&
            textSimilarity(item.observation, existing.observation) >= DEDUP_THRESHOLD;

          if (isDedupMatch && existing) {
            mergedCount += 1;
            docs.push({
              id: existing.id,
              session_id: existing.session_id || validatedInput.sessionId,
              observation: item.observation,
              observation_type: existing.observation_type || item.observationType,
              source: validatedInput.trigger,
              timestamp: existing.timestamp || timestampUnix,
              merged_count: asFiniteNumber(existing.merged_count, 1) + 1,
              updated_at: timestampIso,
              superseded_by: existing.superseded_by ?? null,
              supersedes: existing.supersedes ?? null,
            });
          } else {
            docs.push({
              id: randomUUID(),
              session_id: validatedInput.sessionId,
              observation: item.observation,
              observation_type: item.observationType,
              source: validatedInput.trigger,
              timestamp: timestampUnix,
              merged_count: 1,
              updated_at: timestampIso,
              superseded_by: null,
              supersedes: null,
            });
          }
        }

        const result = await typesense.bulkImport("memory_observations", docs);

        // Dual-write to Convex for real-time UI
        const { pushContentResource } = await import("../../lib/convex");
        for (const doc of docs) {
          const category = doc.observation_type || "general";
          await pushContentResource(
            `obs:${doc.id}`,
            "memory_observation",
            {
              observationId: doc.id,
              observation: doc.observation,
              category,
              source: doc.source,
              sessionId: doc.session_id,
              superseded: false,
              timestamp: doc.timestamp,
            },
            [doc.observation, category, doc.source].filter(Boolean).join(" ")
          ).catch((err) => {
            console.error("[observe] Convex dual-write failed:", err);
          });
        }

        return { stored: true, count: result.success, errors: result.errors, mergedCount };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { stored: false, count: 0, error: message };
      }
    });
    await step.run("otel-observe-store-result", async () => {
      const storeError = "error" in typesenseStoreResult ? typesenseStoreResult.error : undefined;
      const mergedCount = "mergedCount" in typesenseStoreResult ? typesenseStoreResult.mergedCount : 0;
      const storeErrors = "errors" in typesenseStoreResult ? typesenseStoreResult.errors : 0;
      if (!typesenseStoreResult.stored) {
        await emitOtelEvent({
          level: "error",
          source: "worker",
          component: "observe",
          action: "observe.store.failed",
          success: false,
          error: storeError ?? "typesense_store_failed",
          metadata: {
            sessionId: validatedInput.sessionId,
            trigger: validatedInput.trigger,
          },
        });
        return;
      }
      await emitOtelEvent({
        level: "info",
        source: "worker",
        component: "observe",
        action: "observe.store.completed",
        success: true,
        metadata: {
          sessionId: validatedInput.sessionId,
          trigger: validatedInput.trigger,
          storedCount: typesenseStoreResult.count,
          mergedCount,
          errors: storeErrors,
        },
      });
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

    const thresholdCheck = await step.run("check-threshold", async () => {
      return {
        shouldEmitAccumulated: validatedInput.trigger !== "backfill",
      };
    });

    const accumulatedEventPayload = {
      name: "memory/observations.accumulated" as const,
      data: accumulatedData,
    };

    const accumulatedEvent = thresholdCheck.shouldEmitAccumulated
      ? await step.sendEvent("emit-accumulated", [accumulatedEventPayload])
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
          })
      : {
          emitted: false,
          suppressed: true,
          reason: "backfill-trigger",
          name: accumulatedEventPayload.name,
          data: accumulatedEventPayload.data,
          observationCount,
          redisUpdated: redisStateResult,
        };

    // Notify gateway — memory pipeline completed
    await step.run("notify-gateway", async () => {
      if (!gateway) return;
      try {
        await gateway.notify("memory.observed", {
          sessionId: validatedInput.sessionId,
          trigger: validatedInput.trigger,
          observations: observationCount,
          qdrantStored: qdrantStoreResult.stored && "count" in qdrantStoreResult ? qdrantStoreResult.count : 0,
          hasRealVectors: qdrantStoreResult.hasRealVectors ?? false,
        });
      } catch (err) {
        console.error("[observe] Gateway notify failed:", err);
      }
    });
    await step.run("otel-observe-finish", async () => {
      await emitOtelEvent({
        level: "debug",
        source: "worker",
        component: "observe",
        action: "observe.completed",
        success: Boolean(redisStateResult.updated),
        metadata: {
          sessionId: validatedInput.sessionId,
          trigger: validatedInput.trigger,
          observationCount,
          redisUpdated: redisStateResult.updated,
          dailyLogAppended: dailyLogResult.appended,
        },
      });
    });

    return {
      sessionId: validatedInput.sessionId,
      accumulatedEvent,
    };
  }
);
