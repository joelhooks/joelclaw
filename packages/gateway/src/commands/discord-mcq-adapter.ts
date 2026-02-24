/**
 * Discord MCQ Adapter — interactive multiple-choice via discord.js buttons (ADR-0122)
 *
 * Parallel to mcq-adapter.ts (Telegram). When the agent calls the MCQ tool
 * from a Discord source, this adapter renders interactive buttons in the
 * channel/thread instead of using Telegram inline keyboards.
 *
 * Uses discord.js directly (not discordjs-react renderer) because the
 * renderer's type:"message" path doesn't handle initial sends. Buttons +
 * EmbedBuilder + ActionRowBuilder give us everything we need for MCQs.
 */

import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  type TextBasedChannel,
  type MessageComponentInteraction,
  type Client,
} from "discord.js";
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
const COLORS = {
  active: 0x5865f2,     // Discord blurple
  answered: 0x2ecc71,   // Green
  title: 0x9b59b6,      // Purple
  critical: 0xe74c3c,   // Red
};

let activeAdapter: DiscordMcqAdapterRuntime | undefined;

export function getActiveDiscordMcqAdapter(): DiscordMcqAdapterRuntime | undefined {
  return activeAdapter;
}

function buildQuestionEmbed(q: McqQuestion): EmbedBuilder {
  const lines: string[] = [`**${q.question}**`];

  if (q.context?.trim()) {
    lines.push(`*${q.context.trim()}*`);
  }
  lines.push("");

  for (let i = 0; i < q.options.length; i++) {
    const badge = q.recommended === i + 1 ? " ★" : "";
    lines.push(`**${i + 1}.** ${q.options[i]}${badge}`);
  }
  lines.push(`**${q.options.length + 1}.** Other`);

  if (q.recommendedReason?.trim()) {
    const prefix =
      q.recommended && q.recommended > 0
        ? `Recommended (${q.recommended} ★)`
        : "Recommendation";
    lines.push("");
    lines.push(`*${prefix}: ${q.recommendedReason.trim()}*`);
  }

  const color = q.weight === "critical" ? COLORS.critical : COLORS.active;

  return new EmbedBuilder()
    .setDescription(lines.join("\n"))
    .setColor(color);
}

function buildAnsweredEmbed(question: string, answer: string, autoSelected = false): EmbedBuilder {
  const prefix = autoSelected ? "⏱ Auto-selected" : "✅";
  return new EmbedBuilder()
    .setDescription(`**${question}**\n\n${prefix} \`${answer}\``)
    .setColor(COLORS.answered);
}

function buildButtons(questionId: string, options: string[], recommended?: number): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>();

  for (let i = 0; i < options.length; i++) {
    const isRec = recommended === i + 1;
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`mcq:${questionId}:${i}`)
        .setLabel(`${i + 1}${isRec ? " ★" : ""}`)
        .setStyle(isRec ? ButtonStyle.Success : ButtonStyle.Secondary),
    );
  }

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`mcq:${questionId}:other`)
      .setLabel("Other")
      .setStyle(ButtonStyle.Secondary),
  );

  return row;
}

async function askQuestion(
  channel: TextBasedChannel,
  client: Client,
  question: McqQuestion,
  autoSelectTimeoutMs: number,
): Promise<string> {
  const embed = buildQuestionEmbed(question);
  const questionId = `${question.id}-${Date.now().toString(36)}`;
  const buttons = buildButtons(questionId, question.options, question.recommended);

  // Send the question with buttons
  const msg = await (channel as any).send({
    embeds: [embed],
    components: [buttons],
  });

  // Wait for button click or timeout
  return new Promise<string>((resolve) => {
    let settled = false;
    let autoSelectTimer: ReturnType<typeof setTimeout> | undefined;
    let collector: any;

    const settle = async (answer: string, isAuto = false) => {
      if (settled) return;
      settled = true;

      if (autoSelectTimer) clearTimeout(autoSelectTimer);
      if (collector) collector.stop();

      // Update message to show selected answer
      try {
        await msg.edit({
          embeds: [buildAnsweredEmbed(question.question, answer, isAuto)],
          components: [], // remove buttons
        });
      } catch (error) {
        console.error("[gateway:discord-mcq] failed to edit answer", { error: String(error) });
      }

      resolve(answer);
    };

    // Button click collector
    collector = msg.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: autoSelectTimeoutMs > 0 ? autoSelectTimeoutMs + 5000 : 120_000,
    });

    collector.on("collect", async (interaction: MessageComponentInteraction) => {
      try {
        await interaction.deferUpdate();
      } catch { /* non-critical */ }

      const parts = interaction.customId.split(":");
      const optionToken = parts[parts.length - 1];

      if (optionToken === "other") {
        try {
          await interaction.followUp({
            content: "Reply in this thread with your custom answer.",
            ephemeral: true,
          });
        } catch { /* */ }
        await settle("(custom — see thread)");
        return;
      }

      const optionIndex = parseInt(optionToken!, 10);
      const selected = question.options[optionIndex];
      if (typeof selected === "string") {
        await settle(selected);
      }
    });

    collector.on("end", () => {
      if (!settled) {
        // Timeout without selection
        const rec = question.recommended
          ? question.options[question.recommended - 1]
          : undefined;
        void settle(rec ?? "(timeout)", !!rec);
      }
    });

    // Auto-select recommended after timeout
    if (autoSelectTimeoutMs > 0 && question.recommended && question.recommended >= 1) {
      const rec = question.options[question.recommended - 1];
      if (rec) {
        autoSelectTimer = setTimeout(() => {
          void settle(rec, true);
        }, autoSelectTimeoutMs);
      }
    }
  });
}

/**
 * Register the Discord MCQ adapter.
 */
export function registerDiscordMcqAdapter(
  fetchChannel: (id: string) => Promise<TextBasedChannel | undefined>,
  getClient: () => Client | undefined,
): DiscordMcqAdapterRuntime {
  const handleMcqToolCall = async (
    params: DiscordMcqParams,
    channelId: string,
  ): Promise<Record<string, string>> => {
    const channel = await fetchChannel(channelId);
    const client = getClient();
    if (!channel || !client) {
      console.error("[gateway:discord-mcq] channel or client not found", { channelId });
      throw new Error(`Discord channel ${channelId} not found`);
    }

    const autoSelectTimeoutMs = params.timeout
      ? params.timeout * 1000
      : DEFAULT_AUTO_SELECT_TIMEOUT_MS;

    const startedAt = Date.now();

    // Send title if provided
    if (params.title?.trim()) {
      try {
        const titleEmbed = new EmbedBuilder()
          .setDescription(`**${params.title}**`)
          .setColor(COLORS.title);
        await (channel as any).send({ embeds: [titleEmbed] });
      } catch (error) {
        console.error("[gateway:discord-mcq] failed to send title", { error: String(error) });
      }
    }

    // Ask questions sequentially
    const answers: Record<string, string> = {};
    for (const question of params.questions) {
      try {
        answers[question.id] = await askQuestion(channel, client, question, autoSelectTimeoutMs);
      } catch (error) {
        console.error("[gateway:discord-mcq] question failed", {
          questionId: question.id,
          error: String(error),
        });
        answers[question.id] = "(error)";
      }
    }

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

    return answers;
  };

  const runtime: DiscordMcqAdapterRuntime = { handleMcqToolCall };
  activeAdapter = runtime;
  return runtime;
}
