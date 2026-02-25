import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Content, Root } from "mdast";

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

export type MdastNode = Content;

type MdastRoot = Root & { children: MdastNode[] };

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

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

function sanitizeAttribute(value: string): string {
  return value.replace(/"/g, "&quot;");
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

      const [, slash, tagNameRaw, attrsRaw] = match;
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
    case "lineBreak":
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

  const ast = unified().use(remarkParse).use(remarkGfm).parse(md) as MdastRoot;
  const root = unified().use(remarkParse).use(remarkGfm).runSync(ast);
  const children = (root as MdastRoot).children ?? [];
  const rendered = children.map(renderNode).filter((chunk) => chunk.trim().length > 0);
  if (!rendered.length) return "";

  return collapseConsecutiveNewlines(rendered.join("\n")).trim();
}

function splitCodeBlockChunk(html: string): string[] {
  const match = html.match(/^<pre><code([^>]*)>([\s\S]*)<\/code><\/pre>$/);
  if (!match) return [html];
  const open = `<pre><code${match[1]}>`;
  const close = "</code></pre>";
  const body = match[2] ?? "";
  const maxBody = CHUNK_MAX - open.length - close.length;
  if (maxBody <= 1 || body.length <= maxBody) return [html];

  const chunks: string[] = [];
  for (let index = 0; index < body.length; index += maxBody) {
    chunks.push(`${open}${body.slice(index, index + maxBody)}${close}`);
  }
  return chunks;
}

export function chunkTelegramHtml(html: string, nodes: MdastNode[]): string[] {
  if (!html && nodes.length === 0) return [];

  const renderedNodes = nodes
    .map(renderNode)
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => collapseConsecutiveNewlines(chunk));

  if (!renderedNodes.length) return [html];

  const chunks: string[] = [];
  let current = "";
  for (const nodeHtml of renderedNodes) {
    if (/^<pre><code/.test(nodeHtml) && nodeHtml.includes("</code></pre>") && nodeHtml.length > CHUNK_MAX) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(...splitCodeBlockChunk(nodeHtml));
      continue;
    }

    if (!current) {
      current = nodeHtml;
      continue;
    }

    const candidate = `${current}\n${nodeHtml}`;
    if (candidate.length <= CHUNK_MAX) {
      current = candidate;
      continue;
    }

    chunks.push(current);
    current = nodeHtml;
  }

  if (current) chunks.push(current);
  return chunks;
}
