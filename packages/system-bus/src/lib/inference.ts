/**
 * LLM inference via pi sessions.
 *
 * Pi handles auth, token refresh, provider routing — everything.
 * Uses Joel's Claude Pro/Max subscription — zero API cost.
 *
 * Usage:
 *   import { infer } from "../../lib/inference";
 *   const result = await infer("Summarize this text: ...");
 *   const json = await infer("Extract entities", { model: "anthropic/claude-haiku-4-5", json: true });
 */

import { $ } from "bun";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type InferOptions = {
  /** Model ID (pi format). Default: uses pi's default (Sonnet) */
  model?: string;
  /** System prompt */
  system?: string;
  /** Parse output as JSON */
  json?: boolean;
  /** Timeout in ms. Default: 120000 */
  timeout?: number;
};

export type InferResult = {
  /** Raw text output */
  text: string;
  /** Parsed JSON (if json: true) */
  data?: unknown;
};

/**
 * Run LLM inference via a headless pi session.
 * Pi handles auth, token refresh, provider selection — zero config.
 */
export async function infer(prompt: string, opts: InferOptions = {}): Promise<InferResult> {
  const timeout = opts.timeout ?? 120_000;

  // Write prompt to temp file to avoid shell escaping issues
  const tmpDir = await mkdtemp(join(tmpdir(), "infer-"));
  const promptPath = join(tmpDir, "prompt.txt");
  await writeFile(promptPath, prompt, "utf-8");

  try {
    const args: string[] = [
      "pi",
      "-p", "--no-session", "--no-extensions",
    ];

    if (opts.model) {
      args.push("--model", opts.model);
    }
    if (opts.json) {
      args.push("--mode", "json");
    }
    if (opts.system) {
      args.push("--system-prompt", opts.system);
    }

    // Pipe prompt via stdin
    const proc = Bun.spawn(args, {
      stdin: Bun.file(promptPath),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PATH: `${process.env.HOME}/.local/bin:${process.env.HOME}/.bun/bin:${process.env.HOME}/.local/share/fnm/aliases/default/bin:${process.env.PATH}`,
      },
    });

    const timeoutId = setTimeout(() => proc.kill(), timeout);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    clearTimeout(timeoutId);

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`pi inference failed (exit ${exitCode}): ${stderr.slice(0, 500)}`);
    }

    const text = stdout.trim();
    const result: InferResult = { text };

    if (opts.json) {
      try {
        result.data = JSON.parse(text);
      } catch {
        // Try to extract JSON from text
        const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
        if (match) {
          result.data = JSON.parse(match[0]);
        }
      }
    }

    return result;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
