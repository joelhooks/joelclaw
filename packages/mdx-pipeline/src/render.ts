/**
 * Standalone markdown → HTML renderer using the shared pipeline.
 * Used for pre-rendering vault notes at sync time.
 */

import rehypeStringify from "rehype-stringify";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { getRemarkPlugins, rehypePlugins } from "./plugins";
import type { RemarkObsidianOptions } from "./remark-obsidian";

// ── Obsidian callouts (pre-processor) ───────────────────────────

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

// ── Renderer ────────────────────────────────────────────────────

/**
 * Render markdown to HTML using the shared joelclaw pipeline.
 * Includes Obsidian callout resolution as a pre-processing step.
 */
export async function renderMarkdown(
  markdown: string,
  obsidianOptions?: RemarkObsidianOptions
): Promise<string> {
  // Pre-process callouts (not a remark plugin — regex on raw text)
  const processed = resolveCallouts(markdown);

  // Build processor with shared plugins
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let processor: any = unified().use(remarkParse);

  for (const plugin of getRemarkPlugins(obsidianOptions)) {
    if (Array.isArray(plugin)) {
      processor = processor.use(plugin[0], plugin[1]);
    } else {
      processor = processor.use(plugin);
    }
  }

  processor = processor.use(remarkRehype, { allowDangerousHtml: true });

  for (const plugin of rehypePlugins) {
    if (Array.isArray(plugin)) {
      processor = processor.use(plugin[0], plugin[1]);
    } else {
      processor = processor.use(plugin);
    }
  }

  processor = processor.use(rehypeStringify, { allowDangerousHtml: true });

  const result = await processor.process(processed);
  return String(result);
}
