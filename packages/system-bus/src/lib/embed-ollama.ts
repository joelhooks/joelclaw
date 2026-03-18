/**
 * Embed text via ollama's /api/embed endpoint (GPU-accelerated).
 * ADR-0234: ~150x faster than Typesense CPU auto-embedding for nomic-embed-text.
 *
 * Ollama runs on the host at localhost:11434.
 * Model: nomic-embed-text (768-dim, retrieval-tuned).
 */

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";
const OLLAMA_EMBED_BATCH_SIZE = 100; // ollama handles batches efficiently
const OLLAMA_EMBED_TIMEOUT_MS = 30_000;

export type EmbedResult = {
  embeddings: number[][];
  model: string;
  count: number;
};

/**
 * Embed a batch of texts via ollama. Returns one 768-dim vector per input text.
 * Automatically batches large inputs into groups of 100.
 */
// nomic-embed-text has 8192 token context (~32K chars). Truncate to be safe.
const MAX_CHARS_PER_TEXT = 8_000;

function truncateForEmbedding(text: string): string {
  if (text.length <= MAX_CHARS_PER_TEXT) return text;
  return text.slice(0, MAX_CHARS_PER_TEXT);
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const allEmbeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += OLLAMA_EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + OLLAMA_EMBED_BATCH_SIZE).map(truncateForEmbedding);
    const response = await fetch(`${OLLAMA_URL}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_EMBED_MODEL,
        input: batch,
      }),
      signal: AbortSignal.timeout(OLLAMA_EMBED_TIMEOUT_MS),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama embed failed (${response.status}): ${text}`);
    }

    const result = (await response.json()) as { embeddings?: number[][] };
    if (!result.embeddings || result.embeddings.length !== batch.length) {
      throw new Error(
        `Ollama returned ${result.embeddings?.length ?? 0} embeddings for ${batch.length} inputs`
      );
    }

    allEmbeddings.push(...result.embeddings);
  }

  return allEmbeddings;
}

/**
 * Embed a single text. Convenience wrapper.
 */
export async function embedText(text: string): Promise<number[]> {
  const [embedding] = await embedTexts([text]);
  if (!embedding) throw new Error("Ollama returned no embedding");
  return embedding;
}
