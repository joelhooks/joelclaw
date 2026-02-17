import { inngest } from "../client";
import { NonRetriableError } from "inngest";
import { execSync } from "node:child_process";
import { join } from "node:path";

const EMBED_SCRIPT = join(__dirname, "..", "..", "..", "scripts", "embed.py");

/**
 * Generic embedding function — any Inngest function can invoke this
 * to get 768-dim vectors from all-mpnet-base-v2 (local, no API cost).
 *
 * Usage from another function:
 *   const result = await step.invoke("get-embeddings", {
 *     function: embedText,
 *     data: { texts: [{ id: "a", text: "some text" }] }
 *   });
 *   // result.vectors = [{ id: "a", vector: [0.1, ...] }]
 */
export const embedText = inngest.createFunction(
  {
    id: "embedding-generate",
    name: "Generate Embeddings",
    retries: 2,
  },
  { event: "embedding/text.requested" },
  async ({ event, step }) => {
    const { texts } = event.data;

    if (!texts || texts.length === 0) {
      return { vectors: [], count: 0 };
    }

    // Validate input
    for (const item of texts) {
      if (!item.id || !item.text) {
        throw new NonRetriableError(
          `Each text item must have 'id' and 'text'. Got: ${JSON.stringify(item)}`
        );
      }
    }

    const vectors = await step.run("embed-batch", async () => {
      const input = texts
        .map((item: { id: string; text: string }) => JSON.stringify(item))
        .join("\n");

      const output = execSync(
        `uv run --with sentence-transformers ${EMBED_SCRIPT}`,
        {
          input,
          encoding: "utf-8",
          timeout: 120_000, // 2min for model load + batch
          maxBuffer: 50 * 1024 * 1024, // 50MB for large batches
        }
      );

      const results: { id: string; vector: number[] }[] = JSON.parse(
        output.trim()
      );

      return results;
    });

    return {
      vectors,
      count: vectors.length,
      model: "all-mpnet-base-v2",
      dimensions: 768,
    };
  }
);
