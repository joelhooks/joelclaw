/**
 * LLM inference via pi's Anthropic OAuth token.
 *
 * Uses Joel's Claude Pro/Max subscription — zero API cost.
 * Reads ~/.pi/agent/auth.json for the access token.
 * Token refresh is handled by pi and pi-rotate.
 *
 * Usage:
 *   import { infer } from "../../lib/inference";
 *   const result = await infer({
 *     model: "claude-sonnet-4-20250514",
 *     system: "You are a helpful assistant.",
 *     messages: [{ role: "user", content: "Hello" }],
 *   });
 *   console.log(result.text);
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const PI_AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");

export type InferMessage = {
  role: "user" | "assistant";
  content: string;
};

export type InferOptions = {
  /** Anthropic model ID. Default: claude-sonnet-4-20250514 */
  model?: string;
  /** System prompt */
  system?: string;
  /** Conversation messages */
  messages: InferMessage[];
  /** Temperature (0-1). Default: 0.2 */
  temperature?: number;
  /** Max output tokens. Default: 4096 */
  max_tokens?: number;
  /** Abort timeout in ms. Default: 60000 */
  timeout?: number;
};

export type InferResult = {
  /** Concatenated text output */
  text: string;
  /** Raw content blocks */
  content: Array<{ type: string; text?: string }>;
  /** Token usage */
  usage?: { input_tokens?: number; output_tokens?: number };
  /** Model used */
  model: string;
};

async function getPiAnthropicKey(): Promise<string> {
  try {
    const data = JSON.parse(await readFile(PI_AUTH_PATH, "utf-8"));
    const key = data?.anthropic?.access;
    if (!key) throw new Error("No anthropic.access in auth.json");
    return key;
  } catch (e) {
    throw new Error(`Failed to read pi Anthropic token: ${(e as Error).message}`);
  }
}

/**
 * Run LLM inference using pi's Anthropic OAuth token.
 * Zero cost — uses Joel's Claude Pro/Max subscription.
 */
export async function infer(opts: InferOptions): Promise<InferResult> {
  const apiKey = await getPiAnthropicKey();
  const model = opts.model ?? "claude-sonnet-4-20250514";
  const timeout = opts.timeout ?? 60_000;

  const body: Record<string, unknown> = {
    model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.max_tokens ?? 4096,
  };
  if (opts.system) {
    body.system = opts.system;
  }

  const response = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });

  const rawBody = await response.text();
  if (!response.ok) {
    throw new Error(`Anthropic API failed (${response.status}): ${rawBody.slice(0, 800)}`);
  }

  const parsed = JSON.parse(rawBody) as {
    content: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
    model: string;
  };

  const text = parsed.content
    ?.filter((b) => b.type === "text" && b.text)
    .map((b) => b.text)
    .join("\n");

  if (!text) {
    throw new Error("Anthropic returned empty response");
  }

  return {
    text: text.trim(),
    content: parsed.content,
    usage: parsed.usage,
    model: parsed.model,
  };
}
