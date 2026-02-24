/**
 * Convenience wrapper for rendering MCQ flow to a Discord channel.
 * Keeps React.createElement inside the tsx-aware package so consumers
 * (like gateway) don't need jsx config.
 */

import React from "react";
import type { TextBasedChannel } from "discord.js";
import { renderToChannel } from "../runtime.ts";
import { McqFlow } from "../components/mcq.tsx";
import type { McqQuestionData } from "../components/mcq.tsx";

export type RenderMcqOptions = {
  title?: string;
  questions: McqQuestionData[];
  autoSelectTimeoutMs?: number;
  onComplete: (answers: Record<string, string>) => void;
};

/**
 * Render an interactive MCQ flow to a Discord channel/thread.
 */
export function renderMcqToChannel(channel: TextBasedChannel, options: RenderMcqOptions): void {
  renderToChannel(
    channel,
    <McqFlow
      title={options.title}
      questions={options.questions}
      autoSelectTimeoutMs={options.autoSelectTimeoutMs}
      onComplete={options.onComplete}
    />,
  );
}
