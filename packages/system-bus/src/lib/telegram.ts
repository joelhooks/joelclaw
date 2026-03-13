const TELEGRAM_API = "https://api.telegram.org";

function escapeTelegramHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeTelegramAttribute(value: string): string {
  return escapeTelegramHtml(value).replaceAll('"', "&quot;");
}

export function stripOperatorRelayRules(text: string): string {
  const marker = "Operator relay rules:";
  const idx = text.indexOf(marker);
  if (idx < 0) return text.trim();
  return text.slice(0, idx).trim();
}

export function toTelegramHtml(markdown: string): string {
  const links: string[] = [];
  const withLinkPlaceholders = markdown.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_, label: string, url: string) => {
      const placeholder = `__TG_LINK_${links.length}__`;

      links.push(
        `<a href="${escapeTelegramAttribute(url)}">${escapeTelegramHtml(label)}</a>`,
      );

      return placeholder;
    },
  );

  const escaped = escapeTelegramHtml(withLinkPlaceholders)
    .replace(/^## (.+)$/gm, "<b>$1</b>")
    .replace(/^# (.+)$/gm, "<b>$1</b>")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  return escaped.replace(/__TG_LINK_(\d+)__/g, (_, index: string) => {
    return links[Number(index)] ?? "";
  });
}

export async function sendTelegramDirect(
  text: string,
  options?: { silent?: boolean; disablePreview?: boolean },
): Promise<{ ok: boolean; error?: string }> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_USER_ID;

  if (!token || !chatId) {
    return {
      ok: false,
      error: "TELEGRAM_BOT_TOKEN or TELEGRAM_USER_ID not set",
    };
  }

  try {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: options?.disablePreview ?? false,
        disable_notification: options?.silent ?? false,
      }),
    });

    if (!res.ok) {
      const body = await res.text();

      return {
        ok: false,
        error: `Telegram ${res.status}: ${body.slice(0, 200)}`,
      };
    }

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
