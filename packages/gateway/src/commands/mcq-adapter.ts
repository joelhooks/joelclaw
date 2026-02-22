import type { Bot } from "grammy";

type McqQuestion = {
  id: string;
  question: string;
  options: string[];
  context?: string;
  recommended?: number;
  recommendedReason?: string;
};

export type McqParams = {
  title?: string;
  questions: McqQuestion[];
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
  settle: (answer: string) => void;
};

type PendingFreeText = {
  questionId: string;
};

const MCQ_PREFIX = "mcq:";
const QUESTION_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_BUTTON_LABEL_CHARS = 26;
const MAX_OPTION_LINE_CHARS = 72;

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

function optionButtonLabel(option: string, index: number, recommended?: boolean): string {
  const prefix = `${index + 1}) `;
  const suffix = recommended ? " ⭐" : "";
  const available = Math.max(1, MAX_BUTTON_LABEL_CHARS - prefix.length - suffix.length);
  const body = compactText(option, available);
  return `${prefix}${body}${suffix}`;
}

function optionSummaryLine(option: string, index: number, recommended?: boolean): string {
  const prefix = `${index + 1}) `;
  const suffix = recommended ? " ⭐" : "";
  const available = Math.max(1, MAX_OPTION_LINE_CHARS - prefix.length - suffix.length);
  const body = compactText(option, available);
  return `${prefix}${body}${suffix}`;
}

function formatQuestionHtml(question: McqQuestion): string {
  const lines: string[] = [`<b>${escapeHtml(question.question)}</b>`];

  if (question.context?.trim()) {
    lines.push(`<i>${escapeHtml(question.context.trim())}</i>`);
  }

  if (question.options.length > 0) {
    const compactLines = question.options.map((option, index) =>
      escapeHtml(optionSummaryLine(option, index, question.recommended === index + 1)),
    );
    lines.push(`<i>Options:</i>\n${compactLines.join("\n")}`);
  }

  return lines.join("\n\n");
}

function selectedHtml(questionText: string, context: string | undefined, answer: string): string {
  const lines: string[] = [`<b>${escapeHtml(questionText)}</b>`];

  if (context?.trim()) {
    lines.push(`<i>${escapeHtml(context.trim())}</i>`);
  }

  lines.push(`✅ Selected: <code>${escapeHtml(answer)}</code>`);
  return lines.join("\n\n");
}

function buildKeyboard(
  question: McqQuestion,
  callbackQuestionId: string,
): Array<Array<{ text: string; callback_data: string }>> {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];

  for (let i = 0; i < question.options.length; i += 1) {
    const option = question.options[i] ?? "";
    const isRecommended = question.recommended === i + 1;
    const text = optionButtonLabel(option, i, isRecommended);
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
  rows.push([{ text: "Other", callback_data: otherData }]);

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

  const askQuestion = async (question: McqQuestion, targetChatId: number): Promise<string> => {
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

    const answer = await new Promise<string>((resolve) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        pendingQuestions.delete(callbackQuestionId);
        if (pendingFreeText.get(targetChatId)?.questionId === callbackQuestionId) {
          pendingFreeText.delete(targetChatId);
        }
        resolve("(timeout)");
      }, QUESTION_TIMEOUT_MS);

      const settle = (selected: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        pendingQuestions.delete(callbackQuestionId);
        if (pendingFreeText.get(targetChatId)?.questionId === callbackQuestionId) {
          pendingFreeText.delete(targetChatId);
        }
        resolve(selected);
      };

      pendingQuestions.set(callbackQuestionId, {
        chatId: targetChatId,
        messageId,
        questionId: callbackQuestionId,
        questionText: question.question,
        context: question.context,
        options: question.options,
        settle,
      });
    });

    try {
      await bot.api.editMessageText(
        targetChatId,
        messageId,
        selectedHtml(question.question, question.context, answer),
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

        const answers: Record<string, string> = {};
        for (const question of params.questions) {
          try {
            answers[question.id] = await askQuestion(question, targetChatId);
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
