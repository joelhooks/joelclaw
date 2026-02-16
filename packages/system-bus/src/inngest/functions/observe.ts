import { inngest } from "../client.ts";
import { QdrantClient } from "@qdrant/js-client-rest";
import Redis from "ioredis";
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
    redisClient = new Redis({
      host: process.env.REDIS_HOST ?? "localhost",
      port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
      lazyConnect: true,
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
    throw new Error(`Missing required session field: ${fieldName}`);
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
  },
  [
    { event: "memory/session.compaction.pending" },
    { event: "memory/session.ended" },
  ],
  async ({ event, step }) => {
    const validatedInput = await step.run("validate-input", async () =>
      validateObserveInput(event.name, event.data)
    );

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
        const result = await Bun.$`pi --system ${OBSERVER_SYSTEM_PROMPT} --prompt ${promptWithSessionContext}`
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

    const qdrantStoreResult = await step.run("store-to-qdrant", async () => {
      try {
        const qdrantClient = new QdrantClient({
          host: "localhost",
          port: 6333,
        });

        await qdrantClient.getCollections();

        const observationItems = createObservationItems(parsedObservations);
        if (observationItems.length === 0) {
          return {
            stored: true,
            count: 0,
            sourceSessionId: validatedInput.sessionId,
          };
        }

        const timestamp = validatedInput.capturedAt ?? new Date().toISOString();
        const points = observationItems.map((item, index) => ({
          id: `${validatedInput.sessionId}-${index + 1}-${Date.now()}`,
          vector: QDRANT_ZERO_VECTOR,
          payload: {
            session_id: validatedInput.sessionId,
            timestamp,
            observation_type: item.observationType,
            observation: item.observation,
          } satisfies QdrantPointPayload,
        }));

        await qdrantClient.upsert(QDRANT_COLLECTION, {
          wait: true,
          points,
        });

        return {
          stored: true,
          count: points.length,
          sourceSessionId: validatedInput.sessionId,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          stored: false,
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
          qdrant: qdrantStoreResult,
        },
      };

      try {
        await getRedisClient().set(redisKey, JSON.stringify(redisPayload));
        return {
          updated: true,
          key: redisKey,
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

    const accumulatedEvent = await step.run("emit-accumulated", async () => {
      const accumulatedData = {
        session_id: validatedInput.sessionId,
        sessionId: validatedInput.sessionId,
        date,
        totalTokens,
        observationCount,
        observation_count: observationCount,
        capturedAt,
      };

      try {
        await inngest.send({
          name: "memory/observations.accumulated",
          data: accumulatedData,
        });

        return {
          emitted: true,
          name: "memory/observations.accumulated",
          data: accumulatedData,
          observationCount,
          redisUpdated: redisStateResult,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          emitted: false,
          name: "memory/observations.accumulated",
          data: accumulatedData,
          error: message,
          observationCount,
          redisUpdated: redisStateResult,
        };
      }
    });

    return {
      sessionId: validatedInput.sessionId,
      accumulatedEvent,
    };
  }
);
