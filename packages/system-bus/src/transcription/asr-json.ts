/**
 * mlx_whisper emits bare NaN tokens in its JSON on near-silent audio
 * ("avg_logprob": NaN — 88 of them in one real meeting track). Python's json
 * module tolerates that; strict JSON.parse does not. Every reader of an ASR
 * claim check must go through this parser or a NaN-bearing chunk fails
 * validation forever across retries.
 */

/**
 * Replaces bare NaN/Infinity value tokens with null, then JSON.parse. The
 * regex only matches the token in value position (after `:`, `,` or `[`), so
 * transcript text containing the word "NaN" — always inside a quoted string —
 * is untouched.
 */
export function parseAsrJson(text: string): unknown {
  const sanitized = text.replace(
    /([:,[]\s*)(-?Infinity|NaN)(?=\s*[,\]}])/g,
    "$1null",
  );
  return JSON.parse(sanitized);
}
