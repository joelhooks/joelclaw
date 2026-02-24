/**
 * Discord MCQ Adapter — interactive multiple-choice via discordjs-react (ADR-0122)
 *
 * Parallel to mcq-adapter.ts (Telegram). When the agent calls the MCQ tool
 * from a Discord source, this adapter renders interactive buttons in the thread
 * instead of using Telegram inline keyboards.
 */

import type { TextBasedChannel } from "discord.js";
import { emitGatewayOtel } from "../observability";

type McqQuestion = {
  id: string;
  question: string;
  options: string[];
  context?: string;
  recommended?: number;
  recommendedReason?: string;
  weight?: "critical" | "normal" | "minor";
  conviction?: "strong" | "slight";
};

export type DiscordMcqParams = {
  title?: string;
  questions: McqQuestion[];
  timeout?: number;
};

export type DiscordMcqAdapterRuntime = {
  handleMcqToolCall: (
    params: DiscordMcqParams,
    channelId: string,
  ) => Promise<Record<string, string>>;
};

const DEFAULT_AUTO_SELECT_TIMEOUT_MS = 30_000;

let activeAdapter: DiscordMcqAdapterRuntime | undefined;

export function getActiveDiscordMcqAdapter(): DiscordMcqAdapterRuntime | undefined {
  return activeAdapter;
}

/**
 * Register the Discord MCQ adapter.
 * Called once after discord-ui is initialized.
 */
export function registerDiscordMcqAdapter(
  fetchChannel: (id: string) => Promise<TextBasedChannel | undefined>,
): DiscordMcqAdapterRuntime {
  const handleMcqToolCall = async (
    params: DiscordMcqParams,
    channelId: string,
  ): Promise<Record<string, string>> => {
    const channel = await fetchChannel(channelId);
    if (!channel) {
      console.error("[gateway:discord-mcq] channel not found", { channelId });
      throw new Error(`Discord channel ${channelId} not found`);
    }

    // Dynamically import discord-ui to avoid pulling React into gateway's main bundle.
    // We use renderMcqFlow() which wraps the React.createElement call inside the
    // discord-ui package (which has jsx configured), so gateway stays .ts-only.
    const { renderMcqToChannel } = await import("@joelclaw/discord-ui");

    const autoSelectTimeoutMs = params.timeout
      ? params.timeout * 1000
      : DEFAULT_AUTO_SELECT_TIMEOUT_MS;

    return new Promise<Record<string, string>>((resolve) => {
      const startedAt = Date.now();

      const handleComplete = (answers: Record<string, string>) => {
        void emitGatewayOtel({
          level: "info",
          component: "discord-mcq",
          action: "discord-mcq.completed",
          success: true,
          duration_ms: Date.now() - startedAt,
          metadata: {
            channelId,
            questionCount: params.questions.length,
            answeredCount: Object.keys(answers).length,
          },
        });
        resolve(answers);
      };

      renderMcqToChannel(channel, {
        title: params.title,
        questions: params.questions,
        autoSelectTimeoutMs,
        onComplete: handleComplete,
      });

      void emitGatewayOtel({
        level: "info",
        component: "discord-mcq",
        action: "discord-mcq.rendered",
        success: true,
        metadata: {
          channelId,
          questionCount: params.questions.length,
          title: params.title,
        },
      });
    });
  };

  const runtime: DiscordMcqAdapterRuntime = { handleMcqToolCall };
  activeAdapter = runtime;
  return runtime;
}
