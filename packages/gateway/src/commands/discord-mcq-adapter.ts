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
import { emitGatewayOtel } from "@joelclaw/telemetry";

type McqQuestion = {
  id: string;
  question: string;
  options: string[];
  mode?: "quiz" | "decision";
  context?: string;
  recommended?: number;
  recommendedReason?: string;
  weight?: "critical" | "normal" | "minor";
  conviction?: "strong" | "slight";
};

export type DiscordMcqParams = {
  title?: string;
  questions: McqQuestion[];
  mode?: "quiz" | "decision";
  correctAnswers?: Record<string, number>;
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
  skipped: 0xf39c12,    // Orange
};

let activeAdapter: DiscordMcqAdapterRuntime | undefined;

export function getActiveDiscordMcqAdapter(): DiscordMcqAdapterRuntime | undefined {
  return activeAdapter;
}

type McqMode = "quiz" | "decision";

function normalizeMode(mode: DiscordMcqParams["mode"]): McqMode {
  return mode === "quiz" ? "quiz" : "decision";
}

function buildQuestionEmbed(q: McqQuestion, mode: McqMode): EmbedBuilder {
  const lines: string[] = [`**${q.question}**`];
  const showRecommendation = mode === "decision";

  if (q.context?.trim()) {
    lines.push(`*${q.context.trim()}*`);
  }
  lines.push("");

  for (let i = 0; i < q.options.length; i++) {
    const badge = showRecommendation && q.recommended === i + 1 ? " ★" : "";
    lines.push(`**${i + 1}.** ${q.options[i]}${badge}`);
  }
  lines.push(`**${q.options.length + 1}.** Other`);

  if (showRecommendation && q.recommendedReason?.trim()) {
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

function buildSkippedEmbed(question: string): EmbedBuilder {
  return new EmbedBuilder()
    .setDescription(`**${question}**\n\n⏱ Time's up — skipped`)
    .setColor(COLORS.skipped);
}

function buildQuizSummaryEmbed(
  questions: McqQuestion[],
  answers: Record<string, string>,
  correctAnswers: Record<string, number> | undefined,
): EmbedBuilder {
  let correctCount = 0;

  const lines = questions.map((question, index) => {
    const expectedIndex = correctAnswers?.[question.id];
    if (!Number.isInteger(expectedIndex) || !expectedIndex || expectedIndex < 1 || expectedIndex > question.options.length) {
      return `🟥 Q${index + 1}: no correct answer configured`;
    }

    const expected = question.options[expectedIndex - 1];
    const selected = answers[question.id];
    const isCorrect = selected === expected;
    if (isCorrect) {
      correctCount += 1;
    }

    const marker = isCorrect ? "🟩" : "🟥";
    const selectedLabel = selected ?? "⏱ skipped";
    return `${marker} Q${index + 1}: your \`${selectedLabel}\` · correct \`${expected}\``;
  });

  return new EmbedBuilder()
    .setDescription(`**You got ${correctCount}/${questions.length} correct!**\n\n${lines.join("\n")}`)
    .setColor(correctCount === questions.length ? COLORS.answered : COLORS.critical);
}

function buildButtons(
  questionId: string,
  options: string[],
  recommended: number | undefined,
  mode: McqMode,
): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>();
  const showRecommendation = mode === "decision";

  for (let i = 0; i < options.length; i++) {
    const isRec = showRecommendation && recommended === i + 1;
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
  mode: McqMode,
): Promise<string | undefined> {
  const embed = buildQuestionEmbed(question, mode);
  const questionId = `${question.id}-${Date.now().toString(36)}`;
  const buttons = buildButtons(questionId, question.options, question.recommended, mode);

  // Send the question with buttons
  const msg = await (channel as any).send({
    embeds: [embed],
    components: [buttons],
  });

  // Wait for button click or timeout
  return new Promise<string | undefined>((resolve) => {
    let settled = false;
    let autoSelectTimer: ReturnType<typeof setTimeout> | undefined;
    let collector: any;

    const settle = async (answer: string | undefined, state: "selected" | "auto" | "skipped" = "selected") => {
      if (settled) return;
      settled = true;

      if (autoSelectTimer) clearTimeout(autoSelectTimer);
      if (collector) collector.stop();

      // Update message to show selected answer
      try {
        const nextEmbed = state === "skipped"
          ? buildSkippedEmbed(question.question)
          : buildAnsweredEmbed(question.question, answer ?? "(timeout)", state === "auto");
        await msg.edit({
          embeds: [nextEmbed],
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
      time: autoSelectTimeoutMs > 0
        ? (mode === "decision" ? autoSelectTimeoutMs + 5000 : autoSelectTimeoutMs)
        : 120_000,
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
        if (mode === "quiz") {
          void settle(undefined, "skipped");
          return;
        }
        // Timeout without selection (decision mode)
        const rec = question.recommended
          ? question.options[question.recommended - 1]
          : undefined;
        void settle(rec ?? "(timeout)", rec ? "auto" : "selected");
      }
    });

    // Auto-select recommended after timeout (decision mode only)
    if (
      mode === "decision"
      && autoSelectTimeoutMs > 0
      && question.recommended
      && question.recommended >= 1
    ) {
      const rec = question.options[question.recommended - 1];
      if (rec) {
        autoSelectTimer = setTimeout(() => {
          void settle(rec, "auto");
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
    const mode = normalizeMode(params.mode);
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
        const answer = await askQuestion(channel, client, question, autoSelectTimeoutMs, mode);
        if (typeof answer === "string") {
          answers[question.id] = answer;
        }
      } catch (error) {
        console.error("[gateway:discord-mcq] question failed", {
          questionId: question.id,
          error: String(error),
        });
        answers[question.id] = "(error)";
      }
    }

    if (mode === "quiz") {
      try {
        await (channel as any).send({
          embeds: [buildQuizSummaryEmbed(params.questions, answers, params.correctAnswers)],
        });
      } catch (error) {
        console.error("[gateway:discord-mcq] failed to send quiz summary", { error: String(error) });
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
        mode,
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
