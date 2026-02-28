import { chunkByNodes } from "../chunker";
import { escapeText, sanitizeAttribute } from "../escape";
import { parseMd } from "../parser";
import type { FormatConverter, MdastNode, MdastRoot } from "../types";
import { validateTelegramHtml } from "../validators";

const CHUNK_MAX = 4000;

const ALLOWED_INLINE_TAGS = new Set([
  "b",
  "i",
  "u",
  "s",
  "code",
  "pre",
  "blockquote",
  "tg-spoiler",
  "a",
]);

function hasChildren(node: unknown): node is { children: unknown[] } {
  return (
    typeof node === "object" &&
    node !== null &&
    "children" in node &&
    Array.isArray((node as { children?: unknown[] }).children)
  );
}

function getChildren(node: MdastNode): MdastNode[] {
  if (!hasChildren(node)) return [];
  return (node.children as MdastNode[]).filter((child): child is MdastNode => child !== undefined);
}

function sanitizeHtmlNode(raw: string): string {
  return raw
    .split(/(<[^>]+>)/g)
    .map((segment) => {
      if (!segment.startsWith("<") || !segment.endsWith(">")) {
        return escapeText(segment);
      }

      const match = segment.match(/^<\s*(\/?)\s*([a-zA-Z][\w-]*)([^>]*)\s*>$/);
      if (!match) {
        return escapeText(segment);
      }

      const [, slash, tagNameRaw = "", attrsRaw = ""] = match;
      const tagName = tagNameRaw.toLowerCase();
      const isClose = slash === "/";
      if (!ALLOWED_INLINE_TAGS.has(tagName)) {
        return escapeText(segment);
      }

      if (tagName === "a") {
        if (isClose) return "</a>";
        const hrefMatch = attrsRaw.match(/href\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/i);
        const href = hrefMatch ? sanitizeAttribute(hrefMatch[2] ?? hrefMatch[3] ?? hrefMatch[4] ?? "") : "";
        const hrefAttr = href ? ` href="${href}"` : "";
        return `<a${hrefAttr}>`;
      }

      return isClose ? `</${tagName}>` : `<${tagName}>`;
    })
    .join("");
}

function renderListItem(node: MdastNode, index: number | null): string {
  const marker = index === null ? "•" : `${index}.`;
  const children = getChildren(node);
  const rendered = children.map((child) => {
    if (child.type === "paragraph") return renderNode(child);
    return renderNode(child);
  });
  const content = rendered.filter(Boolean).join("\n").trim();
  if (!content) return `${marker} `;

  const lines = content.split("\n");
  const [first, ...rest] = lines;
  if (rest.length === 0) return `${marker} ${first}`;
  return [
    `${marker} ${first}`,
    ...rest.map((line) => `  ${line}`),
  ].join("\n");
}

function renderTableCell(node: MdastNode): string {
  return renderNodeChildren(node).trim();
}

function renderNodeChildren(node: MdastNode): string {
  const children = getChildren(node);
  if (!children.length) return "";
  return children.map((child) => renderNode(child)).join("");
}

function renderNode(node: MdastNode): string {
  switch (node.type) {
    case "heading": {
      const content = renderNodeChildren(node);
      return `\n<b>${content}</b>\n`;
    }
    case "paragraph":
      return renderNodeChildren(node).trim();
    case "blockquote":
      return `<blockquote>${renderNodeChildren(node).trim()}</blockquote>`;
    case "strong": {
      const children = getChildren(node);
      if (children.length === 1 && children[0]!.type === "emphasis") {
        return `<b><i>${renderNodeChildren(children[0]!)}</i></b>`;
      }
      return `<b>${renderNodeChildren(node)}</b>`;
    }
    case "emphasis": {
      const children = getChildren(node);
      if (children.length === 1 && children[0]!.type === "strong") {
        return `<b><i>${renderNodeChildren(children[0]!)}</i></b>`;
      }
      return `<i>${renderNodeChildren(node)}</i>`;
    }
    case "delete":
      return `<s>${renderNodeChildren(node)}</s>`;
    case "text":
      return escapeText((node as { value?: string }).value ?? "");
    case "inlineCode":
      return `<code>${escapeText((node as { value?: string }).value ?? "")}</code>`;
    case "code": {
      const lang = typeof (node as { lang?: string }).lang === "string" ? (node as { lang: string }).lang.trim() : "";
      const langAttr = lang ? ` class="language-${lang}"` : "";
      return `<pre><code${langAttr}>${escapeText((node as { value?: string }).value ?? "")}</code></pre>`;
    }
    case "link": {
      const href = typeof (node as { url?: string }).url === "string" ? (node as { url: string }).url : "";
      return `<a href="${sanitizeAttribute(href)}">${renderNodeChildren(node)}</a>`;
    }
    case "list": {
      const children = getChildren(node);
      if (!children.length) return "";
      const isOrdered = Boolean((node as { ordered?: boolean }).ordered);
      const start = (node as { start?: number }).start ?? 1;
      return children
        .map((child, idx) => renderListItem(child, isOrdered ? start + idx : null))
        .filter(Boolean)
        .join("\n");
    }
    case "table": {
      return getChildren(node)
        .map((row) => {
          if (row.type !== "tableRow") return "";
          const cells = getChildren(row).map(renderTableCell).map((c) => c.trim()).filter(Boolean);
          return cells.join("  ·  ");
        })
        .filter(Boolean)
        .join("\n");
    }
    case "thematicBreak":
      return "───────────────";
    case "html":
      return sanitizeHtmlNode((node as { value?: string }).value ?? "");
    case "break":
      return "\n";
    default:
      return hasChildren(node) ? renderNodeChildren(node) : "";
  }
}

function collapseConsecutiveNewlines(html: string): string {
  return html.replace(/\n{3,}/g, "\n\n");
}

export function mdToTelegramHtmlAst(md: string): string {
  const normalized = md.trim();
  if (!normalized) return "";

  const root = parseMd(md) as MdastRoot;
  const children = (root as MdastRoot).children ?? [];
  const rendered = children.map(renderNode).filter((chunk) => chunk.trim().length > 0);
  if (!rendered.length) return "";

  return collapseConsecutiveNewlines(rendered.join("\n\n")).trim();
}

export function chunkTelegramHtml(html: string, nodes: MdastNode[]): string[] {
  if (!html && nodes.length === 0) return [];

  const chunks = chunkByNodes(nodes, (node) => collapseConsecutiveNewlines(renderNode(node)), CHUNK_MAX);
  if (!chunks.length) return [html];
  return chunks;
}

export class TelegramConverter implements FormatConverter {
  readonly platform = "telegram";
  readonly maxLength = CHUNK_MAX;

  convert(md: string): string {
    return mdToTelegramHtmlAst(md);
  }

  chunk(md: string): string[] {
    const root = parseMd(md) as MdastRoot;
    const html = this.convert(md);
    return chunkTelegramHtml(html, root.children ?? []);
  }

  validate(output: string) {
    return validateTelegramHtml(output);
  }
}
