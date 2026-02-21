/**
 * Vault markdown → HTML renderer for sync-time pre-rendering.
 *
 * Shares the same remark/rehype pipeline as joelclaw.com MDX blog posts
 * (apps/web/lib/mdx-plugins.ts) — same theme, same plugins, same output.
 *
 * Additions for vault: Obsidian callout blocks, vault-local wikilink resolution.
 */
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkSmartypants from "remark-smartypants";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import rehypeSlug from "rehype-slug";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypePrettyCode from "rehype-pretty-code";
import rehypeExternalLinks from "rehype-external-links";
import type { Options as PrettyCodeOptions } from "rehype-pretty-code";
import { getSingletonHighlighter } from "shiki";

// ── Shared config — must match apps/web/lib/mdx-plugins.ts ──────

const SHIKI_THEME = "catppuccin-macchiato";

const SHIKI_LANGS = [
  "plaintext",
  "bash",
  "python",
  "yaml",
  "typescript",
  "javascript",
  "json",
  "markdown",
  "graphql",
  "swift",
] as const;

const prettyCodeOptions: PrettyCodeOptions = {
  theme: {
    dark: SHIKI_THEME,
    light: SHIKI_THEME,
  },
  grid: true,
  keepBackground: true,
  defaultLang: {
    block: "plaintext",
    inline: "plaintext",
  },
  getHighlighter: async (options) =>
    getSingletonHighlighter({
      ...options,
      themes: [SHIKI_THEME],
      langs: [...SHIKI_LANGS],
    }),
};

// ── Obsidian callouts ───────────────────────────────────────────

/**
 * Convert Obsidian callout syntax to HTML.
 * > [!type] Title
 * > Content
 */
function resolveCallouts(markdown: string): string {
  return markdown.replace(
    /^> \[!(\w+)\]([+-]?)\s*(.*?)$\n((?:^>.*$\n?)*)/gm,
    (_match, type: string, fold: string, title: string, body: string) => {
      const cleanBody = body
        .split("\n")
        .map((line: string) => line.replace(/^>\s?/, ""))
        .join("\n")
        .trim();
      const titleText = title.trim() || type.charAt(0).toUpperCase() + type.slice(1);
      const foldable = fold === "+" || fold === "-";
      const open = fold !== "-";

      if (foldable) {
        return `<details class="callout callout-${type.toLowerCase()}"${open ? " open" : ""}><summary>${titleText}</summary>\n\n${cleanBody}\n\n</details>\n`;
      }
      return `<div class="callout callout-${type.toLowerCase()}"><p class="callout-title">${titleText}</p>\n\n${cleanBody}\n\n</div>\n`;
    }
  );
}

// ── Wikilink resolution (vault-specific) ────────────────────────

/**
 * Convert [[wikilinks]] to vault navigation links.
 * For vault notes, resolves to /vault?path=... (not /adrs/ like the blog).
 */
function resolveWikilinks(markdown: string, notePaths: Set<string>): string {
  return markdown.replace(
    /\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g,
    (_match, target: string, heading: string | undefined, display: string | undefined) => {
      const label = display || target;
      const targetLower = target.toLowerCase().trim();
      let resolvedPath = "";

      for (const p of notePaths) {
        const fileName = p.split("/").pop()?.replace(".md", "") || "";
        if (fileName.toLowerCase() === targetLower) {
          resolvedPath = p;
          break;
        }
      }

      if (resolvedPath) {
        const hash = heading ? `#${heading.toLowerCase().replace(/\s+/g, "-")}` : "";
        return `[${label}](/vault?path=${encodeURIComponent(resolvedPath)}${hash})`;
      }

      return `<span class="wikilink-unresolved">${label}</span>`;
    }
  );
}

// ── Processor ───────────────────────────────────────────────────

let _processor: ReturnType<typeof unified> | null = null;

function getProcessor() {
  if (!_processor) {
    _processor = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkSmartypants)
      .use(remarkRehype, { allowDangerousHtml: true })
      .use(rehypeSlug)
      .use(rehypeAutolinkHeadings, { behavior: "wrap" } as any)
      .use(rehypePrettyCode, prettyCodeOptions)
      .use(rehypeExternalLinks, { target: "_blank", rel: ["noopener", "noreferrer"] } as any)
      .use(rehypeStringify, { allowDangerousHtml: true });
  }
  return _processor;
}

/**
 * Render vault markdown to HTML with Obsidian-flavored features.
 * Uses the same pipeline as joelclaw.com blog posts (catppuccin-macchiato,
 * GFM, smartypants, pretty-code, external links, slug headings).
 *
 * Vault-specific additions: callout blocks, wikilink → /vault?path= resolution.
 */
export async function renderVaultMarkdown(
  markdown: string,
  allPaths: Set<string> = new Set()
): Promise<string> {
  // Pre-process: resolve Obsidian-specific syntax before unified pipeline
  let processed = resolveCallouts(markdown);
  processed = resolveWikilinks(processed, allPaths);

  const result = await getProcessor().process(processed);
  return String(result);
}
