/**
 * ADR-0243 Rule 9a: embed concurrency is an Inngest-managed knob with priority lanes.
 *
 * Ollama serializes embed calls internally. Raw HTTP concurrency is a fake
 * optimization — what matters is who waits. This module enforces priority
 * ordering at the HTTP-client layer with a single-writer queue.
 *
 * Priorities (highest to lowest):
 *   - "query"            — interactive search; must never be starved
 *   - "ingest-realtime"  — live Run captures; normal priority
 *   - "ingest-bulk"      — reindex/backfill/spike; drops out when query or
 *                          realtime work is pending
 */

export type EmbeddingPriority = "query" | "ingest-realtime" | "ingest-bulk";

const PRIORITY_RANK: Record<EmbeddingPriority, number> = {
  query: 0,
  "ingest-realtime": 1,
  "ingest-bulk": 2,
};

export interface EmbedOptions {
  priority?: EmbeddingPriority;
  model?: string;
  dimensions?: number;
  host?: string;
}

export interface EmbeddingResult {
  embedding: number[];
  model: string;
  dimensions: number;
  priority: EmbeddingPriority;
  /** ms the caller waited in the priority queue before embedding started */
  queued_ms: number;
  /** ms Ollama spent producing the vector */
  compute_ms: number;
  /** ms total from submit to result */
  total_ms: number;
}

const DEFAULT_MODEL = "qwen3-embedding:8b";
const DEFAULT_DIMENSIONS = 768;
const DEFAULT_HOST = "http://localhost:11434";
const DEFAULT_PRIORITY: EmbeddingPriority = "query";

interface QueueEntry {
  priority: EmbeddingPriority;
  seq: number;
  submittedAt: number;
  run: () => Promise<void>;
}

class PriorityEmbedClient {
  private readonly queue: QueueEntry[] = [];
  private running = false;
  private seq = 0;

  submit<T>(priority: EmbeddingPriority, work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry = {
        priority,
        seq: this.seq++,
        submittedAt: performance.now(),
        run: async () => {
          try {
            resolve(await work());
          } catch (err) {
            reject(err);
          }
        },
      };
      this.enqueue(entry);
      void this.drain();
    });
  }

  private enqueue(entry: QueueEntry) {
    const rank = PRIORITY_RANK[entry.priority];
    let i = 0;
    while (i < this.queue.length) {
      const other = this.queue[i]!;
      const otherRank = PRIORITY_RANK[other.priority];
      if (otherRank > rank) break;
      if (otherRank === rank && other.seq > entry.seq) break;
      i += 1;
    }
    this.queue.splice(i, 0, entry);
  }

  peekDepthByPriority(): Record<EmbeddingPriority, number> {
    const counts: Record<EmbeddingPriority, number> = {
      query: 0,
      "ingest-realtime": 0,
      "ingest-bulk": 0,
    };
    for (const entry of this.queue) counts[entry.priority] += 1;
    return counts;
  }

  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const next = this.queue.shift();
        if (!next) break;
        await next.run();
      }
    } finally {
      this.running = false;
    }
  }
}

const defaultClient = new PriorityEmbedClient();

export function embedQueueDepth(): Record<EmbeddingPriority, number> {
  return defaultClient.peekDepthByPriority();
}

async function callOllama(
  input: string,
  model: string,
  dimensions: number,
  host: string
): Promise<{ embedding: number[]; compute_ms: number }> {
  const t0 = performance.now();
  const response = await fetch(`${host}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input, dimensions }),
  });
  if (!response.ok) {
    throw new Error(
      `ollama embed failed: ${response.status} ${response.statusText}`
    );
  }
  const data = (await response.json()) as { embeddings: number[][] };
  const embedding = data.embeddings?.[0];
  if (!embedding) throw new Error("ollama embed returned no embeddings");
  if (embedding.length !== dimensions) {
    throw new Error(
      `ollama embed returned ${embedding.length} dims, expected ${dimensions}`
    );
  }
  return { embedding, compute_ms: performance.now() - t0 };
}

export async function embed(
  input: string,
  options: EmbedOptions = {}
): Promise<EmbeddingResult> {
  const priority = options.priority ?? DEFAULT_PRIORITY;
  const model = options.model ?? DEFAULT_MODEL;
  const dimensions = options.dimensions ?? DEFAULT_DIMENSIONS;
  const host = options.host ?? DEFAULT_HOST;

  const submitted = performance.now();
  const { embedding, compute_ms } = await defaultClient.submit(priority, () =>
    callOllama(input, model, dimensions, host)
  );
  const total_ms = performance.now() - submitted;
  return {
    embedding,
    model,
    dimensions,
    priority,
    compute_ms,
    queued_ms: total_ms - compute_ms,
    total_ms,
  };
}

export function embeddingModelTag(
  model: string = DEFAULT_MODEL,
  dimensions: number = DEFAULT_DIMENSIONS
): string {
  return `${model.replace(":", "-")}@${dimensions}`;
}
