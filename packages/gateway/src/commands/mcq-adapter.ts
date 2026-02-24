import type { Bot } from "grammy";

type McqQuestion = {
  id: string;
  question: string;
  options: string[];
  mode?: "quiz" | "decision";
  context?: string;
  recommended?: number;
  recommendedReason?: string;
};

export type McqParams = {
  title?: string;
  questions: McqQuestion[];
  mode?: "quiz" | "decision";
  correctAnswers?: Record<string, number>;
  timeout?: number;
};

export type McqAdapterRuntime = {
  handleMcqToolCall: (
    params: McqParams,
    options?: { chatId?: number },
  ) => Promise<Record<string, string>>;
  hasPendingMcq: () => boolean;
};

type PendingQuestion = {
  chatId: number;
  messageId: number;
  questionId: string;
  questionText: string;
  context?: string;
  options: string[];
  cancelAutoSelectTimer: () => void;
  settle: (answer: string) => void;
};

type PendingFreeText = {
  questionId: string;
};

const MCQ_PREFIX = "mcq:";
const DEFAULT_AUTO_SELECT_TIMEOUT_SECS = 30;
const MAX_BUTTON_LABEL_CHARS = 8;
const OTHER_OPTION_LABEL = "Other";

let activeMcqAdapter: McqAdapterRuntime | undefined;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function compactText(text: string, maxLength: number): string {
  const normalized = normalizeText(text) || "(empty)";
  if (maxLength <= 1) {
    return "…";
  }

  const chars = Array.from(normalized);
  if (chars.length <= maxLength) {
    return normalized;
  }

  return `${chars.slice(0, maxLength - 1).join("").trimEnd()}…`;
}

function optionButtonLabel(index: number, recommended?: boolean): string {
  const suffix = recommended ? " ★" : "";
  const label = `${index + 1}${suffix}`;
  const chars = Array.from(label);
  if (chars.length <= MAX_BUTTON_LABEL_CHARS) {
    return label;
  }
  return compactText(label, MAX_BUTTON_LABEL_CHARS);
}

function formatQuestionHtml(question: McqQuestion): string {
  const lines: string[] = [`<b>${escapeHtml(question.question)}</b>`];

  if (question.context?.trim()) {
    lines.push(`<i>${escapeHtml(question.context.trim())}</i>`);
  }

  if (question.options.length > 0) {
    const optionLines = question.options.map((option, index) =>
      `${index + 1}. ${escapeHtml(normalizeText(option) || "(empty)")}${question.recommended === index + 1 ? " ★" : ""}`,
    );
    const otherIndex = question.options.length + 1;
    optionLines.push(`${otherIndex}. ${escapeHtml(OTHER_OPTION_LABEL)}`);
    lines.push(optionLines.join("\n"));
  } else {
    lines.push(`1. ${escapeHtml(OTHER_OPTION_LABEL)}`);
  }

  if (question.recommendedReason?.trim()) {
    const reason = question.recommendedReason.trim();
    const recommendationPrefix = question.recommended && question.recommended > 0
      ? `Recommended (${question.recommended} ★): `
      : "Recommendation: ";
    lines.push(`<i>${escapeHtml(`${recommendationPrefix}${reason}`)}</i>`);
  }

  return lines.join("\n\n");
}

function selectedHtml(
  questionText: string,
  context: string | undefined,
  answer: string,
  autoSelectedOption?: number,
): string {
  const lines: string[] = [`<b>${escapeHtml(questionText)}</b>`];

  if (context?.trim()) {
    lines.push(`<i>${escapeHtml(context.trim())}</i>`);
  }

  lines.push(`✅ Selected: <code>${escapeHtml(answer)}</code>`);
  if (typeof autoSelectedOption === "number") {
    lines.push(`⏱ Auto-selected: option ${autoSelectedOption}`);
  }
  return lines.join("\n\n");
}

function resolveAutoSelectTimeoutSecs(value: unknown): number {
  const raw = typeof value === "number" ? value : DEFAULT_AUTO_SELECT_TIMEOUT_SECS;
  if (!Number.isFinite(raw)) {
    return DEFAULT_AUTO_SELECT_TIMEOUT_SECS;
  }
  return Math.max(0, Math.trunc(raw));
}

function getRecommendedSelection(question: McqQuestion): { optionNumber: number; option: string } | null {
  if (!Number.isInteger(question.recommended)) {
    return null;
  }
  if (!question.recommended || question.recommended < 1 || question.recommended > question.options.length) {
    return null;
  }

  const option = question.options[question.recommended - 1];
  if (typeof option !== "string") {
    return null;
  }

  return {
    optionNumber: question.recommended,
    option,
  };
}

function buildKeyboard(
  question: McqQuestion,
  callbackQuestionId: string,
): Array<Array<{ text: string; callback_data: string }>> {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];

  for (let i = 0; i < question.options.length; i += 1) {
    const isRecommended = question.recommended === i + 1;
    const text = optionButtonLabel(i, isRecommended);
    const callbackData = `${MCQ_PREFIX}${callbackQuestionId}:${i}`;

    if (callbackData.length > 64) {
      console.warn("[gateway:mcq] callback_data exceeds 64 bytes", {
        questionId: question.id,
        callbackDataLength: callbackData.length,
      });
    }

    rows.push([{ text, callback_data: callbackData }]);
  }

  const otherData = `${MCQ_PREFIX}${callbackQuestionId}:other`;
  if (otherData.length > 64) {
    console.warn("[gateway:mcq] callback_data exceeds 64 bytes", {
      questionId: question.id,
      callbackDataLength: otherData.length,
    });
  }
  rows.push([{ text: optionButtonLabel(question.options.length), callback_data: otherData }]);

  return rows;
}

export function getActiveMcqAdapter(): McqAdapterRuntime | undefined {
  return activeMcqAdapter;
}

export function registerMcqAdapter(bot: Bot, chatId: number): McqAdapterRuntime {
  const pendingQuestions = new Map<string, PendingQuestion>();
  const pendingFreeText = new Map<number, PendingFreeText>();
  let activeCalls = 0;
  let queue = Promise.resolve();

  const hasPendingMcq = (): boolean => {
    return activeCalls > 0 || pendingQuestions.size > 0 || pendingFreeText.size > 0;
  };

  bot.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith(MCQ_PREFIX)) {
      await next();
      return;
    }

    try {
      await ctx.answerCallbackQuery();
    } catch (error) {
      console.warn("[gateway:mcq] answerCallbackQuery failed", { error: String(error) });
    }

    const payload = data.slice(MCQ_PREFIX.length);
    const splitAt = payload.lastIndexOf(":");
    if (splitAt <= 0) {
      return;
    }

    const questionId = payload.slice(0, splitAt);
    const optionToken = payload.slice(splitAt + 1);

    const pending = pendingQuestions.get(questionId);
    if (!pending) {
      console.warn("[gateway:mcq] callback for unknown question", { questionId });
      return;
    }

    if (optionToken === "other") {
      pending.cancelAutoSelectTimer();
      pendingFreeText.set(pending.chatId, { questionId });
      try {
        await bot.api.sendMessage(pending.chatId, "Reply with your custom answer.", {
          reply_parameters: { message_id: pending.messageId },
        });
      } catch (error) {
        console.error("[gateway:mcq] failed to prompt for free-text answer", { error: String(error) });
      }
      return;
    }

    const optionIndex = Number.parseInt(optionToken, 10);
    if (Number.isNaN(optionIndex)) {
      console.warn("[gateway:mcq] callback option index invalid", { questionId, optionToken });
      return;
    }

    const selectedOption = pending.options[optionIndex];
    if (typeof selectedOption !== "string") {
      console.warn("[gateway:mcq] callback option index out of range", { questionId, optionIndex });
      return;
    }

    pending.cancelAutoSelectTimer();
    pending.settle(selectedOption);
  });

  bot.on("message:text", async (ctx, next) => {
    const pending = pendingFreeText.get(ctx.chat.id);
    if (!pending) {
      await next();
      return;
    }

    const pendingQuestion = pendingQuestions.get(pending.questionId);
    pendingFreeText.delete(ctx.chat.id);

    if (!pendingQuestion) {
      await next();
      return;
    }

    const text = ctx.message.text.trim();
    pendingQuestion.settle(text.length > 0 ? text : "(empty)");
  });

  const askQuestion = async (
    question: McqQuestion,
    targetChatId: number,
    autoSelectTimeoutSecs: number,
  ): Promise<string> => {
    const callbackQuestionId = question.id.length > 40
      ? `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      : question.id;
    let messageId = 0;

    try {
      const message = await bot.api.sendMessage(targetChatId, formatQuestionHtml(question), {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: buildKeyboard(question, callbackQuestionId) },
      });
      messageId = message.message_id;
    } catch (error) {
      console.error("[gateway:mcq] failed to send question", {
        questionId: question.id,
        error: String(error),
      });
      return "(timeout)";
    }

    const recommendedSelection = getRecommendedSelection(question);
    const shouldStartAutoSelectTimer = autoSelectTimeoutSecs > 0 && recommendedSelection !== null;
    let autoSelectedOptionNumber: number | undefined;

    const answer = await new Promise<string>((resolve) => {
      let settled = false;
      let autoSelectTimer: ReturnType<typeof setTimeout> | undefined;

      const cancelAutoSelectTimer = (): void => {
        if (!autoSelectTimer) return;
        clearTimeout(autoSelectTimer);
        autoSelectTimer = undefined;
      };

      const cleanup = (): void => {
        cancelAutoSelectTimer();
        pendingQuestions.delete(callbackQuestionId);
        if (pendingFreeText.get(targetChatId)?.questionId === callbackQuestionId) {
          pendingFreeText.delete(targetChatId);
        }
      };

      const settle = (selected: string): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(selected);
      };

      pendingQuestions.set(callbackQuestionId, {
        chatId: targetChatId,
        messageId,
        questionId: callbackQuestionId,
        questionText: question.question,
        context: question.context,
        options: question.options,
        cancelAutoSelectTimer,
        settle,
      });

      if (shouldStartAutoSelectTimer && recommendedSelection) {
        autoSelectTimer = setTimeout(() => {
          const pending = pendingQuestions.get(callbackQuestionId);
          if (!pending) return;
          autoSelectedOptionNumber = recommendedSelection.optionNumber;
          pending.settle(recommendedSelection.option);
        }, autoSelectTimeoutSecs * 1000);
      }
    });

    try {
      await bot.api.editMessageText(
        targetChatId,
        messageId,
        selectedHtml(question.question, question.context, answer, autoSelectedOptionNumber),
        {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [] },
        },
      );
    } catch (error) {
      const message = String(error);
      if (!message.includes("message is not modified")) {
        console.error("[gateway:mcq] failed to edit selected answer", {
          questionId: question.id,
          error: message,
        });
      }
    }

    return answer;
  };

  const runSequential = async <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.then(() => undefined, () => undefined);
    return next;
  };

  const handleMcqToolCall = (params: McqParams, options?: { chatId?: number }): Promise<Record<string, string>> => {
    return runSequential(async () => {
      activeCalls += 1;
      const targetChatId = options?.chatId ?? chatId;

      try {
        if (params.title?.trim()) {
          try {
            await bot.api.sendMessage(targetChatId, `<b>${escapeHtml(params.title.trim())}</b>`, {
              parse_mode: "HTML",
            });
          } catch (error) {
            console.error("[gateway:mcq] failed to send title", { error: String(error) });
          }
        }

        const autoSelectTimeoutSecs = resolveAutoSelectTimeoutSecs(params.timeout);
        const answers: Record<string, string> = {};
        for (const question of params.questions) {
          try {
            answers[question.id] = await askQuestion(question, targetChatId, autoSelectTimeoutSecs);
          } catch (error) {
            console.error("[gateway:mcq] question handling failed", {
              questionId: question.id,
              error: String(error),
            });
            answers[question.id] = "(timeout)";
          }
        }

        return answers;
      } finally {
        activeCalls = Math.max(0, activeCalls - 1);
      }
    });
  };

  const runtime: McqAdapterRuntime = { handleMcqToolCall, hasPendingMcq };
  activeMcqAdapter = runtime;
  return runtime;
}
