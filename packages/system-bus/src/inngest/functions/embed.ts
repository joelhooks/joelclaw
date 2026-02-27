import { join } from "node:path";
import { NonRetriableError } from "inngest";
import { inngest } from "../client";

const EMBED_SCRIPT = join(__dirname, "..", "..", "..", "scripts", "embed.py");
const EMBED_TIMEOUT_MS = 120_000;
const EMBED_CONCURRENCY_KEY = "embedding-generate";

function readShellText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (value == null) return "";
  return String(value);
}

async function runEmbedScript(input: string): Promise<string> {
  const proc = Bun.spawn(
    ["uv", "run", "--with", "sentence-transformers", EMBED_SCRIPT],
    {
      env: {
        ...process.env,
        TERM: "dumb",
        TQDM_DISABLE: "1",
        HF_HUB_DISABLE_PROGRESS_BARS: "1",
        TOKENIZERS_PARALLELISM: "false",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, EMBED_TIMEOUT_MS);

  try {
    if (proc.stdin) {
      proc.stdin.write(input);
      proc.stdin.end();
    }

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      const timeoutDetail = timedOut ? ` after ${EMBED_TIMEOUT_MS}ms timeout` : "";
      throw new Error(
        `embed subprocess failed${timeoutDetail} (exit ${exitCode})${stderr ? `: ${stderr.slice(0, 500)}` : ""}`
      );
    }

    if (stderr.trim().length > 0) {
      console.warn("[embed] subprocess stderr:", stderr.slice(0, 300));
    }

    return stdout;
  } finally {
    clearTimeout(timeout);
  }
}

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
    concurrency: { limit: 1, key: EMBED_CONCURRENCY_KEY },
    retries: 0,
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

      const output = await runEmbedScript(input);

      const results: { id: string; vector: number[] }[] = JSON.parse(
        readShellText(output).trim()
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
