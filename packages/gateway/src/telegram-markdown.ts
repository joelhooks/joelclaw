import { TelegramFormatConverter } from "@chat-adapter/telegram";
import { markdownToPlainText } from "chat";

export interface TelegramMarkdownFormatter {
  readonly fromMarkdown: (markdown: string) => string;
}

export type TelegramPostableMessage =
  | { readonly markdown: string }
  | { readonly raw: string };

export type PreparedTelegramMarkdown =
  | {
      readonly ok: true;
      readonly markdownV2: string;
      readonly plainText: string;
      readonly postable: { readonly markdown: string };
    }
  | {
      readonly ok: false;
      readonly markdownV2: null;
      readonly plainText: string;
      readonly postable: { readonly raw: string };
      readonly error: unknown;
    };

const formatter: TelegramMarkdownFormatter = new TelegramFormatConverter();
const BULLET_LINE = /^(\s*)[-*+]\s+/gm;

export function normalizeTelegramBulletLines(markdown: string): string {
  return markdown.replace(BULLET_LINE, "$1• ");
}

function toPlainText(markdown: string): string {
  try {
    return markdownToPlainText(markdown) || markdown;
  } catch {
    return markdown;
  }
}

/**
 * Preflight Telegram markdown with the same MarkdownV2 converter used by the
 * Chat SDK adapter. Dash-list markers become visible bullets before both paths
 * render, while blank paragraph separators stay intact. The SDK receives that
 * normalized markdown so it can own its rich-message/MarkdownV2 fallback path.
 */
export function prepareTelegramMarkdown(
  markdown: string,
  markdownFormatter: TelegramMarkdownFormatter = formatter,
): PreparedTelegramMarkdown {
  const normalizedMarkdown = normalizeTelegramBulletLines(markdown);
  const plainText = toPlainText(normalizedMarkdown);
  try {
    const markdownV2 = markdownFormatter.fromMarkdown(normalizedMarkdown);
    if (markdown.trim() && !markdownV2.trim()) {
      throw new Error("Telegram MarkdownV2 conversion returned empty output");
    }
    return {
      ok: true,
      markdownV2,
      plainText,
      postable: { markdown: normalizedMarkdown },
    };
  } catch (error) {
    return {
      ok: false,
      markdownV2: null,
      plainText,
      postable: { raw: plainText },
      error,
    };
  }
}
