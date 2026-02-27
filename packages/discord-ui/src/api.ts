/**
 * Non-JSX API surface for consumers that don't have jsx configured.
 * Re-exports runtime + convenience helpers via dynamic imports.
 */

export type { DiscordUIInstance } from "./runtime.ts";
export { getDiscordUI, initDiscordUI, renderToChannel, shutdownDiscordUI } from "./runtime.ts";

// renderMcqToChannel is in a .tsx file, so we provide an async wrapper
// that dynamically imports it. This avoids the --jsx requirement at the
// import site.

import type { TextBasedChannel } from "discord.js";

export type RenderMcqOptions = {
  title?: string;
  questions: Array<{
    id: string;
    question: string;
    options: string[];
    mode?: "quiz" | "decision";
    context?: string;
    recommended?: number;
    recommendedReason?: string;
    weight?: "critical" | "normal" | "minor";
    conviction?: "strong" | "slight";
  }>;
  mode?: "quiz" | "decision";
  correctAnswers?: Record<string, number>;
  autoSelectTimeoutMs?: number;
  onComplete: (answers: Record<string, string>) => void;
};

export async function renderMcqToChannel(channel: TextBasedChannel, options: RenderMcqOptions): Promise<void> {
  // Dynamic import with string concatenation to prevent TypeScript from resolving
  // the .tsx module at type-check time. Bun resolves it fine at runtime.
  const modulePath = "./helpers/render-mcq" + ".tsx";
  const mod = await import(/* @vite-ignore */ modulePath) as {
    renderMcqToChannel: (channel: TextBasedChannel, options: RenderMcqOptions) => void;
  };
  mod.renderMcqToChannel(channel, options);
}
