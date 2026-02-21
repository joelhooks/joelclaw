/**
 * Vault markdown → HTML renderer for sync-time pre-rendering.
 * Obsidian-flavored: wikilinks, callouts, GFM, syntax highlighting.
 *
 * Used by typesense-sync to pre-render vault notes into HTML
 * stored alongside raw content in Convex.
 */
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import rehypeSlug from "rehype-slug";
import rehypePrettyCode from "rehype-pretty-code";

// ── Wikilink resolution ─────────────────────────────────────────

/**
 * Convert [[wikilinks]] to vault navigation links.
 * Handles: [[Note]], [[Note|display text]], [[Note#heading]]
 */
function resolveWikilinks(markdown: string, notePaths: Set<string>): string {
  return markdown.replace(
    /\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g,
    (_match, target: string, heading: string | undefined, display: string | undefined) => {
      const label = display || target;
      // Try to find the note path
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

      // Unresolved wikilink — render as styled span
      return `<span class="wikilink-unresolved">${label}</span>`;
    }
  );
}

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

// ── Processor ───────────────────────────────────────────────────

let _processor: ReturnType<typeof unified> | null = null;

function getProcessor() {
  if (!_processor) {
    _processor = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkRehype, { allowDangerousHtml: true })
      .use(rehypeSlug)
      .use(rehypePrettyCode, {
        theme: "github-dark-default",
        keepBackground: true,
        defaultLang: "plaintext",
      })
      .use(rehypeStringify, { allowDangerousHtml: true });
  }
  return _processor;
}

/**
 * Render vault markdown to HTML with Obsidian-flavored features.
 * @param markdown - Raw markdown content
 * @param allPaths - Set of all vault note paths for wikilink resolution
 * @returns Rendered HTML string
 */
export async function renderVaultMarkdown(
  markdown: string,
  allPaths: Set<string> = new Set()
): Promise<string> {
  // Pre-process: resolve Obsidian-specific syntax
  let processed = resolveCallouts(markdown);
  processed = resolveWikilinks(processed, allPaths);

  // Render markdown → HTML
  const result = await getProcessor().process(processed);
  return String(result);
}
