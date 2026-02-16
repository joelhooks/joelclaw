import { inngest } from "../client";
import { OBSERVER_SYSTEM_PROMPT, OBSERVER_USER_PROMPT } from "./observe-prompt";

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
    const validatedInput = await step.run("validate-input", async () => event.data);

    const llmOutput = await step.run("call-observer-llm", async () => {
      const sessionName =
        "sessionName" in validatedInput ? validatedInput.sessionName : undefined;

      return `${OBSERVER_SYSTEM_PROMPT}\n\n${OBSERVER_USER_PROMPT(
        validatedInput.messages,
        validatedInput.trigger,
        sessionName
      )}`;
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
