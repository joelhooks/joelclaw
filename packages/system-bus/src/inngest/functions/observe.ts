import { inngest } from "../client";
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

    const parsedObservations = await step.run("parse-observations", async () => ({
      raw: llmOutput,
    }));

    const qdrantStoreResult = await step.run("store-to-qdrant", async () => ({
      stored: false,
      sourceSessionId: validatedInput.sessionId,
      parsedObservations,
    }));

    const redisStateResult = await step.run("update-redis-state", async () => ({
      updated: false,
      dedupeKey: validatedInput.dedupeKey,
      qdrantStoreResult,
    }));

    const accumulatedEvent = await step.run("emit-accumulated", async () => ({
      emitted: false,
      trigger: validatedInput.trigger,
      redisStateResult,
    }));

    return {
      sessionId: validatedInput.sessionId,
      accumulatedEvent,
    };
  }
);
