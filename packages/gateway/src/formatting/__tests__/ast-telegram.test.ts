import { unified } from "unified";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { describe, expect, test } from "vitest";
import { mdToTelegramHtmlAst, chunkTelegramHtml, type MdastNode } from "../ast-telegram";

const CHUNK_MAX = 4000;

function parseNodes(md: string): MdastNode[] {
  const root = unified().use(remarkParse).use(remarkGfm).parse(md) as { children: MdastNode[] };
  return root.children ?? [];
}

function hasOnlyAllowedTags(html: string): boolean {
  const allowedTags = new Set(["b", "i", "u", "s", "code", "pre", "a", "blockquote", "tg-spoiler"]);
  const stack: string[] = [];
  const tagMatch = /<\/?([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^<>]*?)?>/g;
  let match: RegExpExecArray | null;

  while ((match = tagMatch.exec(html)) !== null) {
    const fullTag = match[0] ?? "";
    const tagName = (match[1] ?? "").toLowerCase();
    if (!allowedTags.has(tagName)) return false;

    const isClosing = fullTag.startsWith("</");
    if (!isClosing) {
      stack.push(tagName);
      continue;
    }

    const last = stack.pop();
    if (last !== tagName) return false;
  }

  return stack.length === 0;
}

describe("mdToTelegramHtmlAst", () => {
  test("converts basic markdown to Telegram HTML", () => {
    const html = mdToTelegramHtmlAst("**bold** _italic_ `code` [link](https://example.com)\n# Heading");

    expect(html).toContain("<b>bold</b>");
    expect(html).toContain("<i>italic</i>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain('<a href="https://example.com">link</a>');
    expect(html).toContain("<b>Heading</b>");
  });

  test("handles nested formatting and links inside lists", () => {
    const html = mdToTelegramHtmlAst("***bold italic***\n- [first](https://example.com)\n1. second");
    expect(html).toMatch(/<(?:b><i|i><b)>bold italic<\/(?:i|b)><\/(?:i|b)>/);
    expect(html).toContain("• <a href=\"https://example.com\">first</a>");
    expect(html).toContain("1. second");
  });

  test("renders fenced code blocks with language", () => {
    const html = mdToTelegramHtmlAst("```ts\nconst answer = 42;\n```");
    expect(html.startsWith('<pre><code class="language-ts">')).toBe(true);
    expect(html).toContain("const answer = 42;");
    expect(html).toContain("</code></pre>");
  });

  test("renders blockquotes", () => {
    expect(mdToTelegramHtmlAst("> quoted text")).toBe("<blockquote>quoted text</blockquote>");
  });

  test("renders tables as compact separated text", () => {
    const md = `
| a | b |
| --- | --- |
| 1 | 2 |
| 3 | 4 |
`;
    const html = mdToTelegramHtmlAst(md);
    expect(html).toContain("a  ·  b");
    expect(html).toContain("1  ·  2");
    expect(html).toContain("3  ·  4");
  });

  test("passes through safe HTML tags in markdown input", () => {
    const html = mdToTelegramHtmlAst("<b>safe</b> and <i>inline</i>");
    expect(html).toBe("<b>safe</b> and <i>inline</i>");
  });

  test("escapes forbidden html-like text content", () => {
    const html = mdToTelegramHtmlAst("Use <script> in text");
    expect(html).toBe("Use &lt;script&gt; in text");
  });

  test("handles long chunking at top-level node boundaries", () => {
    const line = "This is a long sentence designed to build message size without adding unsafe structure. ";
    const md = Array.from({ length: 140 }, (_, index) => `${index}: ${line.repeat(8)}`).join("\n\n");
    const html = mdToTelegramHtmlAst(md);
    const nodes = parseNodes(md);
    const chunks = chunkTelegramHtml(html, nodes);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(CHUNK_MAX);
      expect(hasOnlyAllowedTags(chunk)).toBe(true);
    }

    const rejoined = chunks.join("\n");
    // All content from the full render should appear in the rejoined chunks
    expect(rejoined.length).toBeGreaterThanOrEqual(html.length * 0.95);
  });

  test("supports edge cases", () => {
    expect(mdToTelegramHtmlAst("")).toBe("");
    expect(mdToTelegramHtmlAst("   \n  ")).toBe("");

    const codeMd = "```rust\nlet x = 1;\n```";
    const codeHtml = mdToTelegramHtmlAst(codeMd);
    const codeNodes = parseNodes(codeMd);
    const chunks = chunkTelegramHtml(codeHtml, codeNodes);

    expect(codeHtml).toContain("<pre><code");
    expect(codeHtml).toContain("let x = 1;");
    expect(chunks).toEqual([codeHtml]);
  });
});

