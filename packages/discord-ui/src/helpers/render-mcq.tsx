/**
 * Convenience wrapper for rendering MCQ flow to a Discord channel.
 * Keeps React.createElement inside the tsx-aware package so consumers
 * (like gateway) don't need jsx config.
 */

import type { TextBasedChannel } from "discord.js";
import React from "react";
import type { McqQuestionData } from "../components/mcq.tsx";
import { McqFlow } from "../components/mcq.tsx";
import { renderToChannel } from "../runtime.ts";

export type RenderMcqOptions = {
  title?: string;
  questions: McqQuestionData[];
  mode?: "quiz" | "decision";
  correctAnswers?: Record<string, number>;
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
      mode={options.mode}
      correctAnswers={options.correctAnswers}
      autoSelectTimeoutMs={options.autoSelectTimeoutMs}
      onComplete={options.onComplete}
    />,
  );
}
