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
