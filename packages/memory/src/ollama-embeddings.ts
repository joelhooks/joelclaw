export interface OllamaEmbedOptions {
  model?: string;
  dimensions?: number;
  host?: string;
}

export interface OllamaEmbedResult {
  embedding: number[];
  model: string;
  dimensions: number;
  duration_ms: number;
}

const DEFAULT_MODEL = "qwen3-embedding:8b";
const DEFAULT_DIMENSIONS = 768;
const DEFAULT_HOST = "http://localhost:11434";

export async function embed(
  input: string,
  options: OllamaEmbedOptions = {}
): Promise<OllamaEmbedResult> {
  const model = options.model ?? DEFAULT_MODEL;
  const dimensions = options.dimensions ?? DEFAULT_DIMENSIONS;
  const host = options.host ?? DEFAULT_HOST;

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

  const data = (await response.json()) as {
    embeddings: number[][];
    total_duration?: number;
  };

  const embedding = data.embeddings?.[0];
  if (!embedding) {
    throw new Error("ollama embed returned no embeddings");
  }

  if (embedding.length !== dimensions) {
    throw new Error(
      `ollama embed returned ${embedding.length} dims, expected ${dimensions}`
    );
  }

  return {
    embedding,
    model,
    dimensions,
    duration_ms: Math.floor((data.total_duration ?? 0) / 1_000_000),
  };
}

export async function embedMany(
  inputs: string[],
  options: OllamaEmbedOptions & { concurrency?: number } = {}
): Promise<OllamaEmbedResult[]> {
  const concurrency = options.concurrency ?? 8;
  const results: OllamaEmbedResult[] = new Array(inputs.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= inputs.length) break;
      results[idx] = await embed(inputs[idx]!, options);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, inputs.length) },
    worker
  );
  await Promise.all(workers);
  return results;
}

export function embeddingModelTag(
  model: string = DEFAULT_MODEL,
  dimensions: number = DEFAULT_DIMENSIONS
): string {
  return `${model.replace(":", "-")}@${dimensions}`;
}
