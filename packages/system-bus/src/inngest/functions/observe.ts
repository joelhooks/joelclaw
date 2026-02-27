import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NonRetriableError } from "inngest";
import Redis from "ioredis";
// Observability is centralized in packages/system-bus/src/lib/inference.ts (inference router).
import { infer } from "../../lib/inference";
import { getRedisPort } from "../../lib/redis";
import * as typesense from "../../lib/typesense";
import { DEDUP_THRESHOLD } from "../../memory/retrieval";
import { type CategorySource, classifyObservationCategory, type MemoryCategoryId, normalizeCategoryId, TAXONOMY_VERSION } from "../../memory/taxonomy-v1";
import { allowsReflect, resolveWriteGate, type WriteVerdict } from "../../memory/write-gate";
import { emitOtelEvent } from "../../observability/emit";
// ADR-0067: Supersede pattern adapted from knowledge-graph by safatinaztepe (openclaw/skills, MIT).
// ADR-0082: Typesense is the canonical memory store.
import { inngest } from "../client.ts";
import { sanitizeObservationText, sanitizeObservationTranscript } from "./observation-sanitize";
import { parseObserverOutput } from "./observe-parser";
import { OBSERVER_SYSTEM_PROMPT, OBSERVER_USER_PROMPT } from "./observe-prompt";

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

type ObservationItem = {
  observationType: string;
  observation: string;
  writeVerdict: WriteVerdict;
  writeConfidence: number;
  writeReason: string;
  writeGateVersion: string;
  writeGateFallback: boolean;
  categoryId: MemoryCategoryId;
  categoryConfidence: number;
  categorySource: CategorySource;
  taxonomyVersion: string;
};

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
  write_verdict?: WriteVerdict;
  write_confidence?: number;
  write_reason?: string;
  write_gate_version?: string;
  write_gate_fallback?: boolean;
  category_id?: MemoryCategoryId;
  category_confidence?: number;
  category_source?: CategorySource;
  taxonomy_version?: string;
};

let redisClient: Redis | null = null;
const MEMORY_OBSERVATIONS_COLLECTION = "memory_observations";

function isVectorSearchConfigError(message: string): boolean {
  if (/embedded fields|vector query|vector field|no field found for vector query/iu.test(message)) {
    return true;
  }

  const normalized = message.toLowerCase();
  return (
    normalized.includes("vector") &&
    (normalized.includes("unknown field") || normalized.includes("not found") || normalized.includes("missing"))
  );
}

function getRedisClient(): Redis {
  if (!redisClient) {
    const isTestEnv = process.env.NODE_ENV === "test" || process.env.BUN_TEST === "1";
    redisClient = new Redis({
      host: process.env.REDIS_HOST ?? "localhost",
      port: getRedisPort(),
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

function buildObservationItem(observationType: string, rawText: string): ObservationItem | null {
  const sanitizedInput = sanitizeObservationText(rawText);
  if (!sanitizedInput) return null;

  const resolved = resolveWriteGate(sanitizedInput);
  const observation = sanitizeObservationText(resolved.observation);
  if (!observation || observation.length === 0) return null;

  const hintedCategory = normalizeCategoryId(resolved.hintedCategoryId ?? null);
  const category = hintedCategory
    ? {
        categoryId: hintedCategory,
        categoryConfidence: Math.max(0.65, resolved.writeConfidence),
        categorySource: "llm" as const,
        taxonomyVersion: TAXONOMY_VERSION,
      }
    : classifyObservationCategory(observation);

  return {
    observationType,
    observation,
    writeVerdict: resolved.writeVerdict,
    writeConfidence: resolved.writeConfidence,
    writeReason: resolved.writeReason,
    writeGateVersion: resolved.writeGateVersion,
    writeGateFallback: resolved.writeGateFallback,
    categoryId: category.categoryId,
    categoryConfidence: category.categoryConfidence,
    categorySource: category.categorySource,
    taxonomyVersion: category.taxonomyVersion,
  };
}

function createObservationItems(parsedObservations: {
  observations: string;
  segments: unknown[];
}) {
  const items: ObservationItem[] = [];

  for (const rawSegment of parsedObservations.segments) {
    const segment = rawSegment as { narrative?: unknown; facts?: unknown };
    const narrative = typeof segment.narrative === "string" ? segment.narrative.trim() : "";
    if (narrative.length > 0) {
      const item = buildObservationItem("segment_narrative", narrative);
      if (item) items.push(item);
    }

    const facts = Array.isArray(segment.facts) ? segment.facts : [];
    for (const fact of facts) {
      if (typeof fact !== "string") {
        continue;
      }
      const item = buildObservationItem("segment_fact", fact);
      if (item) items.push(item);
    }
  }

  if (items.length > 0) {
    return items;
  }

  if (Array.isArray(parsedObservations.segments) && parsedObservations.segments.length > 0) {
    return items;
  }

  const fallbackObservation = parsedObservations.observations.trim();
  if (fallbackObservation.length > 0) {
    const item = buildObservationItem("observation_text", fallbackObservation);
    if (item) items.push(item);
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
  const write_verdict =
    input.write_verdict === "allow" || input.write_verdict === "hold" || input.write_verdict === "discard"
      ? input.write_verdict
      : "allow";
  const category_id = normalizeCategoryId(
    typeof input.category_id === "string" ? input.category_id : null
  ) ?? "jc:operations";

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
    write_verdict,
    write_confidence: asFiniteNumber(input.write_confidence, 0.35),
    write_reason: typeof input.write_reason === "string" ? input.write_reason : "existing_doc",
    write_gate_version: typeof input.write_gate_version === "string" ? input.write_gate_version : "v1",
    write_gate_fallback: input.write_gate_fallback === true,
    category_id,
    category_confidence: asFiniteNumber(input.category_confidence, 0.35),
    category_source:
      input.category_source === "rules" ||
      input.category_source === "llm" ||
      input.category_source === "fallback" ||
      input.category_source === "external"
        ? input.category_source
        : "fallback",
    taxonomy_version: typeof input.taxonomy_version === "string" ? input.taxonomy_version : TAXONOMY_VERSION,
  };
}

function extractTypesenseBulkImportResponseBody(message: string): string | undefined {
  const match = message.match(/^Typesense bulk import failed \(\d+\):\s*([\s\S]+)$/u);
  if (!match) return undefined;
  const body = match[1]?.trim();
  return body && body.length > 0 ? body : undefined;
}

function buildObserverFallback(input: ObserveInput, sanitizedTranscript: string, reason: string): string {
  const lines = sanitizedTranscript
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 12);

  const bullets =
    lines.length > 0 ? lines.map((line) => `- ${line}`).join("\n") : "- (no transcript lines available)";

  return [
    `Observer fallback used (${input.trigger}) because LLM call failed: ${reason.slice(0, 220)}`,
    "Session notes:",
    bullets,
  ].join("\n");
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
      const sanitizedMessages = sanitizeObservationTranscript(validatedInput.messages);
      const transcriptForPrompt =
        sanitizedMessages.length > 0
          ? sanitizedMessages
          : "No user-facing transcript content available after tool-call sanitization.";
      const userPrompt = OBSERVER_USER_PROMPT(
        transcriptForPrompt,
        validatedInput.trigger,
        sessionName
      );
      const promptWithSessionContext = `${userPrompt}

Session context:
- sessionId: ${validatedInput.sessionId}
- dedupeKey: ${validatedInput.dedupeKey}`;

      const observerModel = "anthropic/claude-haiku";

      try {
        const result = await infer(promptWithSessionContext, {
          model: observerModel,
          task: "summary",
          system: OBSERVER_SYSTEM_PROMPT,
          component: "observe",
          action: "observe.llm.extract",
          timeout: 90_000,
        });
        const stdout = result.text.trim();
        return stdout;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[observe] observer LLM fallback: ${message}`);

        return buildObserverFallback(validatedInput, sanitizedMessages, message);
      }

    });

    const parsedObservations = await step.run(
      "parse-observations",
      async () => {
        try {
          const parsed = parseObserverOutput(llmOutput);
          const facts = parsed.segments
            .flatMap((segment) => segment.facts)
            .map((fact) => sanitizeObservationText(fact))
            .filter((fact): fact is string => typeof fact === "string" && fact.length > 0);
          const concepts = [
            ...new Set(
              [parsed.currentTask, ...parsed.segments.map((segment) => segment.narrative)]
                .map((concept) => sanitizeObservationText((concept ?? "").trim()))
                .filter((concept): concept is string => typeof concept === "string" && concept.length > 0)
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

    // Append to daily log — durable fallback even if Redis/Typesense are down
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
          const narrative =
            typeof segment.narrative === "string"
              ? sanitizeObservationText(segment.narrative)
              : null;
          if (narrative) {
            lines.push(`#### ${narrative}\n`);
          }
          if (Array.isArray(segment.facts)) {
            for (const fact of segment.facts) {
              const sanitizedFact = sanitizeObservationText(fact);
              if (!sanitizedFact) continue;
              lines.push(`${sanitizedFact}`);
            }
            lines.push("");
          }
        }
      } else if (parsedObservations.observations) {
        const fallbackObservation = sanitizeObservationText(parsedObservations.observations);
        if (fallbackObservation) {
          lines.push(fallbackObservation);
          lines.push("");
        }
      }

      if (parsedObservations.currentTask) {
        const currentTask = sanitizeObservationText(parsedObservations.currentTask);
        if (currentTask) {
          lines.push(`**Current task**: ${currentTask}\n`);
        }
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
        const vectorField = await typesense.resolveVectorField(
          MEMORY_OBSERVATIONS_COLLECTION,
          typesense.DEFAULT_VECTOR_FIELD
        );
        const vectorQueryBy = `${vectorField},observation`;
        const vectorQuery = `${vectorField}:([], k:1, distance_threshold: 0.5)`;

        for (const item of observationItems) {
          const includeFields =
            "id,session_id,observation,observation_type,source,timestamp,merged_count,updated_at,superseded_by,supersedes,write_verdict,write_confidence,write_reason,write_gate_version,write_gate_fallback,category_id,category_confidence,category_source,taxonomy_version";
          let similar;
          try {
            similar = await typesense.search({
              collection: MEMORY_OBSERVATIONS_COLLECTION,
              q: item.observation,
              query_by: vectorQueryBy,
              vector_query: vectorQuery,
              per_page: 1,
              include_fields: includeFields,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!isVectorSearchConfigError(message)) {
              throw error;
            }

            // Fallback: text-only dedupe if vector field/search config is unavailable.
            similar = await typesense.search({
              collection: MEMORY_OBSERVATIONS_COLLECTION,
              q: item.observation,
              query_by: "observation",
              per_page: 1,
              include_fields: includeFields,
            });
          }
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
              write_verdict: item.writeVerdict,
              write_confidence: item.writeConfidence,
              write_reason: item.writeReason,
              write_gate_version: item.writeGateVersion,
              write_gate_fallback: item.writeGateFallback,
              category_id: item.categoryId,
              category_confidence: item.categoryConfidence,
              category_source: item.categorySource,
              taxonomy_version: item.taxonomyVersion,
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
              write_verdict: item.writeVerdict,
              write_confidence: item.writeConfidence,
              write_reason: item.writeReason,
              write_gate_version: item.writeGateVersion,
              write_gate_fallback: item.writeGateFallback,
              category_id: item.categoryId,
              category_confidence: item.categoryConfidence,
              category_source: item.categorySource,
              taxonomy_version: item.taxonomyVersion,
            });
          }
        }

        const result = await typesense.bulkImport(MEMORY_OBSERVATIONS_COLLECTION, docs);
        const allowCount = docs.filter((doc) => doc.write_verdict === "allow").length;
        const holdCount = docs.filter((doc) => doc.write_verdict === "hold").length;
        const discardCount = docs.filter((doc) => doc.write_verdict === "discard").length;
        const fallbackCount = docs.filter((doc) => doc.write_gate_fallback === true).length;

        const categoryCounts = new Map<string, number>();
        const categorySourceCounts = new Map<string, number>();
        let categorizedCount = 0;
        let highConfidenceCategoryCount = 0;

        for (const doc of docs) {
          const categoryId = typeof doc.category_id === "string" ? doc.category_id : "";
          if (categoryId.length > 0) {
            categorizedCount += 1;
            categoryCounts.set(categoryId, (categoryCounts.get(categoryId) ?? 0) + 1);
          }

          const categorySource = typeof doc.category_source === "string" ? doc.category_source : "unknown";
          categorySourceCounts.set(categorySource, (categorySourceCounts.get(categorySource) ?? 0) + 1);

          const confidence = asFiniteNumber(doc.category_confidence, 0);
          if (confidence >= 0.8) {
            highConfidenceCategoryCount += 1;
          }
        }

        const categoryBuckets = [...categoryCounts.entries()]
          .map(([id, count]) => ({ id, count }))
          .sort((a, b) => b.count - a.count);
        const categorySourceBuckets = [...categorySourceCounts.entries()]
          .map(([source, count]) => ({ source, count }))
          .sort((a, b) => b.count - a.count);
        const taxonomyVersions = [...new Set(docs
          .map((doc) => (typeof doc.taxonomy_version === "string" ? doc.taxonomy_version : ""))
          .filter((value) => value.length > 0))];

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

        return {
          stored: true,
          count: result.success,
          errors: result.errors,
          mergedCount,
          allowCount,
          holdCount,
          discardCount,
          fallbackCount,
          categorizedCount,
          uncategorizedCount: Math.max(0, docs.length - categorizedCount),
          highConfidenceCategoryCount,
          categoryBuckets,
          categorySourceBuckets,
          taxonomyVersions,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          stored: false,
          count: 0,
          error: message,
          typesenseResponseBody: extractTypesenseBulkImportResponseBody(message),
        };
      }
    });
    await step.run("otel-observe-store-result", async () => {
      const storeError = "error" in typesenseStoreResult ? typesenseStoreResult.error : undefined;
      const resolvedStoreError =
        typeof storeError === "string" && storeError.trim().length > 0 ? storeError : undefined;
      const typesenseResponseBody =
        "typesenseResponseBody" in typesenseStoreResult ? typesenseStoreResult.typesenseResponseBody : undefined;
      const mergedCount = "mergedCount" in typesenseStoreResult ? typesenseStoreResult.mergedCount : 0;
      const storeErrors = "errors" in typesenseStoreResult ? typesenseStoreResult.errors : 0;
      const allowCount = "allowCount" in typesenseStoreResult ? typesenseStoreResult.allowCount : 0;
      const holdCount = "holdCount" in typesenseStoreResult ? typesenseStoreResult.holdCount : 0;
      const discardCount = "discardCount" in typesenseStoreResult ? typesenseStoreResult.discardCount : 0;
      const fallbackCount = "fallbackCount" in typesenseStoreResult ? typesenseStoreResult.fallbackCount : 0;
      const categorizedCount = "categorizedCount" in typesenseStoreResult ? typesenseStoreResult.categorizedCount : 0;
      const uncategorizedCount = "uncategorizedCount" in typesenseStoreResult ? typesenseStoreResult.uncategorizedCount : 0;
      const highConfidenceCategoryCount = "highConfidenceCategoryCount" in typesenseStoreResult
        ? typesenseStoreResult.highConfidenceCategoryCount
        : 0;
      const categoryBuckets = "categoryBuckets" in typesenseStoreResult ? typesenseStoreResult.categoryBuckets : [];
      const categorySourceBuckets = "categorySourceBuckets" in typesenseStoreResult ? typesenseStoreResult.categorySourceBuckets : [];
      const taxonomyVersions = "taxonomyVersions" in typesenseStoreResult ? typesenseStoreResult.taxonomyVersions : [];
      if (!typesenseStoreResult.stored) {
        await emitOtelEvent({
          level: "error",
          source: "worker",
          component: "observe",
          action: "observe.store.failed",
          success: false,
          error: resolvedStoreError ?? "typesense_store_failed",
          metadata: {
            sessionId: validatedInput.sessionId,
            trigger: validatedInput.trigger,
            ...(typeof typesenseResponseBody === "string" && typesenseResponseBody.length > 0
              ? { typesenseResponseBody }
              : {}),
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
          allowCount,
          holdCount,
          discardCount,
          fallbackCount,
          categorizedCount,
          uncategorizedCount,
          categoryCoverageRatio: typesenseStoreResult.count > 0 ? categorizedCount / typesenseStoreResult.count : 0,
          highConfidenceCategoryCount,
          highConfidenceCategoryRatio: typesenseStoreResult.count > 0
            ? highConfidenceCategoryCount / typesenseStoreResult.count
            : 0,
          categoryBuckets: categoryBuckets.slice(0, 10),
          categorySourceBuckets: categorySourceBuckets.slice(0, 10),
          taxonomyVersions,
        },
      });
    });

    const observationItems = createObservationItems(parsedObservations);
    const observationCount = observationItems.length;
    const reflectableItems = observationItems.filter((item) => allowsReflect(item.writeVerdict));
    const reflectableCount = reflectableItems.length;
    const fallbackSummary =
      Array.isArray(parsedObservations.segments) && parsedObservations.segments.length === 0
        ? sanitizeObservationText(parsedObservations.observations) ?? ""
        : "";
    const observationSummary =
      reflectableItems.map((item) => item.observation).join("\n") ||
      fallbackSummary;
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
          reflectable_count: reflectableCount,
          message_count: validatedInput.messageCount,
          captured_at: capturedAt,
          date,
          typesense: {
            stored: typesenseStoreResult.stored,
            count: "count" in typesenseStoreResult ? typesenseStoreResult.count : 0,
            errors: "errors" in typesenseStoreResult ? typesenseStoreResult.errors : 0,
            merged_count: "mergedCount" in typesenseStoreResult ? typesenseStoreResult.mergedCount : 0,
            allow_count: "allowCount" in typesenseStoreResult ? typesenseStoreResult.allowCount : 0,
            hold_count: "holdCount" in typesenseStoreResult ? typesenseStoreResult.holdCount : 0,
            discard_count: "discardCount" in typesenseStoreResult ? typesenseStoreResult.discardCount : 0,
            fallback_count: "fallbackCount" in typesenseStoreResult ? typesenseStoreResult.fallbackCount : 0,
            error: "error" in typesenseStoreResult ? typesenseStoreResult.error : undefined,
          },
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
          reflectableCount,
          summaryLength: observationSummary.length,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          updated: false,
          key: redisKey,
          error: message,
          observationCount,
          reflectableCount,
        };
      }
    });

    const accumulatedData = {
      date,
      totalTokens,
      observationCount,
      reflectableCount,
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
          reflectableObservations: reflectableCount,
          typesenseStored: typesenseStoreResult.stored && "count" in typesenseStoreResult ? typesenseStoreResult.count : 0,
          mergedCount: "mergedCount" in typesenseStoreResult ? typesenseStoreResult.mergedCount : 0,
          allowCount: "allowCount" in typesenseStoreResult ? typesenseStoreResult.allowCount : 0,
          holdCount: "holdCount" in typesenseStoreResult ? typesenseStoreResult.holdCount : 0,
          discardCount: "discardCount" in typesenseStoreResult ? typesenseStoreResult.discardCount : 0,
          fallbackCount: "fallbackCount" in typesenseStoreResult ? typesenseStoreResult.fallbackCount : 0,
          categorizedCount: "categorizedCount" in typesenseStoreResult ? typesenseStoreResult.categorizedCount : 0,
          uncategorizedCount: "uncategorizedCount" in typesenseStoreResult ? typesenseStoreResult.uncategorizedCount : 0,
          taxonomyVersions: "taxonomyVersions" in typesenseStoreResult ? typesenseStoreResult.taxonomyVersions : [],
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
          reflectableCount,
          allowCount: "allowCount" in typesenseStoreResult ? typesenseStoreResult.allowCount : 0,
          holdCount: "holdCount" in typesenseStoreResult ? typesenseStoreResult.holdCount : 0,
          discardCount: "discardCount" in typesenseStoreResult ? typesenseStoreResult.discardCount : 0,
          fallbackCount: "fallbackCount" in typesenseStoreResult ? typesenseStoreResult.fallbackCount : 0,
          categorizedCount: "categorizedCount" in typesenseStoreResult ? typesenseStoreResult.categorizedCount : 0,
          uncategorizedCount: "uncategorizedCount" in typesenseStoreResult ? typesenseStoreResult.uncategorizedCount : 0,
          highConfidenceCategoryCount: "highConfidenceCategoryCount" in typesenseStoreResult
            ? typesenseStoreResult.highConfidenceCategoryCount
            : 0,
          categoryBuckets: "categoryBuckets" in typesenseStoreResult ? typesenseStoreResult.categoryBuckets.slice(0, 10) : [],
          categorySourceBuckets: "categorySourceBuckets" in typesenseStoreResult
            ? typesenseStoreResult.categorySourceBuckets.slice(0, 10)
            : [],
          taxonomyVersions: "taxonomyVersions" in typesenseStoreResult ? typesenseStoreResult.taxonomyVersions : [],
          redisUpdated: redisStateResult.updated,
          dailyLogAppended: dailyLogResult.appended,
        },
      });
    });

    return {
      sessionId: validatedInput.sessionId,
      accumulatedEvent,
      observationCount,
      reflectableCount,
      typesense: {
        stored: typesenseStoreResult.stored,
        count: "count" in typesenseStoreResult ? typesenseStoreResult.count : 0,
        errors: "errors" in typesenseStoreResult ? typesenseStoreResult.errors : 0,
        mergedCount: "mergedCount" in typesenseStoreResult ? typesenseStoreResult.mergedCount : 0,
        allowCount: "allowCount" in typesenseStoreResult ? typesenseStoreResult.allowCount : 0,
        holdCount: "holdCount" in typesenseStoreResult ? typesenseStoreResult.holdCount : 0,
        discardCount: "discardCount" in typesenseStoreResult ? typesenseStoreResult.discardCount : 0,
        fallbackCount: "fallbackCount" in typesenseStoreResult ? typesenseStoreResult.fallbackCount : 0,
        categorizedCount: "categorizedCount" in typesenseStoreResult ? typesenseStoreResult.categorizedCount : 0,
        uncategorizedCount: "uncategorizedCount" in typesenseStoreResult ? typesenseStoreResult.uncategorizedCount : 0,
        highConfidenceCategoryCount: "highConfidenceCategoryCount" in typesenseStoreResult
          ? typesenseStoreResult.highConfidenceCategoryCount
          : 0,
        categoryBuckets: "categoryBuckets" in typesenseStoreResult ? typesenseStoreResult.categoryBuckets : [],
        categorySourceBuckets: "categorySourceBuckets" in typesenseStoreResult
          ? typesenseStoreResult.categorySourceBuckets
          : [],
        taxonomyVersions: "taxonomyVersions" in typesenseStoreResult ? typesenseStoreResult.taxonomyVersions : [],
        error: "error" in typesenseStoreResult ? typesenseStoreResult.error : undefined,
      },
    };
  }
);
