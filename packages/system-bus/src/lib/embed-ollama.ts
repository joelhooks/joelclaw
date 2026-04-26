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
// nomic-embed-text uses nomic-bert, which has an **architecture limit of 2048
// tokens** (not the 8192 num_ctx advertised by ollama). Char-to-token ratios
// vary: lorem ≈ 4/tok but tables/code/CAPS/numbers can be <1.5/tok. Fitness
// books with rep-scheme tables blow past 2048 tokens even at 4000 chars.
// Start at 4000 and shrink on 400 "context length" errors. 2026-04-20 incident.
const MAX_CHARS_PER_TEXT = 4_000;
const MIN_CHARS_PER_TEXT = 500;

function truncateToChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

async function embedBatchOnce(
  batch: string[],
  maxChars: number
): Promise<{ ok: true; embeddings: number[][] } | { ok: false; status: number; body: string }> {
  const truncated = batch.map((t) => truncateToChars(t, maxChars));
  const response = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, input: truncated }),
    signal: AbortSignal.timeout(OLLAMA_EMBED_TIMEOUT_MS),
  });
  if (!response.ok) {
    return { ok: false, status: response.status, body: await response.text() };
  }
  const result = (await response.json()) as { embeddings?: number[][] };
  if (!result.embeddings || result.embeddings.length !== truncated.length) {
    throw new Error(
      `Ollama returned ${result.embeddings?.length ?? 0} embeddings for ${truncated.length} inputs`
    );
  }
  return { ok: true, embeddings: result.embeddings };
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const allEmbeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += OLLAMA_EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + OLLAMA_EMBED_BATCH_SIZE);

    let maxChars = MAX_CHARS_PER_TEXT;
    let attempt = 0;
    // Halve maxChars on "context length" errors until success or floor.
    while (true) {
      attempt++;
      const res = await embedBatchOnce(batch, maxChars);
      if (res.ok) {
        allEmbeddings.push(...res.embeddings);
        break;
      }
      const contextOverflow =
        res.status === 400 && res.body.includes("context length");
      if (contextOverflow && maxChars > MIN_CHARS_PER_TEXT) {
        maxChars = Math.max(MIN_CHARS_PER_TEXT, Math.floor(maxChars / 2));
        continue;
      }
      throw new Error(
        `Ollama embed failed (${res.status}) after ${attempt} attempt(s) at ${maxChars} chars: ${res.body}`
      );
    }
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
