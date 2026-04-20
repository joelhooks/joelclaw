/**
 * ADR-0243 Rule 9a: embed concurrency is an Inngest-managed knob with priority lanes.
 *
 * This function is the durable wrapper around `@joelclaw/inference-router`'s
 * in-process priority queue. The queue itself enforces query > ingest-realtime
 * > ingest-bulk ordering at the HTTP-client layer; this function adds
 * durability + retries + observability for the ingest side.
 *
 * Query-path callers bypass Inngest and call the router directly — durability
 * isn't needed for an interactive search that's already awaiting a response.
 * Only ingest flows fire `memory/embed.requested`.
 *
 * Concurrency is set to 1 to match Ollama's internal serialization — sending
 * more concurrent HTTP requests doesn't help throughput and only confuses
 * scheduling. Priority ordering via the `priority.run` expression ensures
 * that when multiple events are queued, the higher-priority one runs next.
 */

import { embed } from "@joelclaw/inference-router";
import { emitOtelEvent } from "../../../observability/emit";
import { inngest } from "../../client";

export const memoryEmbed = inngest.createFunction(
  {
    id: "memory-embed",
    name: "memory/embed",
    concurrency: { limit: 1 },
    priority: {
      // Lower number = higher priority in Inngest. Map our three lanes to
      // a numeric score; run expression picks up event.data.priority.
      run: "event.data.priority == 'query' ? 0 : event.data.priority == 'ingest-realtime' ? 10 : 100",
    },
    retries: 3,
  },
  { event: "memory/embed.requested" },
  async ({ event, step }) => {
    const { input, priority, dimensions, model, correlation_id } = event.data;

    const result = await step.run("ollama-embed", async () => {
      return await embed(input, {
        priority,
        dimensions,
        model,
      });
    });

    await step.run("emit-otel", async () => {
      emitOtelEvent("memory.embed.completed", {
        priority,
        dimensions: result.dimensions,
        model: result.model,
        queued_ms: Math.round(result.queued_ms),
        compute_ms: Math.round(result.compute_ms),
        total_ms: Math.round(result.total_ms),
        correlation_id,
      });
    });

    await step.sendEvent("emit-completed", {
      name: "memory/embed.completed",
      data: {
        priority,
        dimensions: result.dimensions,
        model: result.model,
        queued_ms: Math.round(result.queued_ms),
        compute_ms: Math.round(result.compute_ms),
        total_ms: Math.round(result.total_ms),
        correlation_id,
      },
    });

    return {
      embedding: result.embedding,
      model: result.model,
      dimensions: result.dimensions,
      queued_ms: result.queued_ms,
      compute_ms: result.compute_ms,
      total_ms: result.total_ms,
    };
  }
);
