/**
 * Vault markdown → HTML renderer.
 * Uses @joelclaw/mdx-pipeline shared rendering package.
 *
 * Vault-specific: wikilinks resolve to /vault?path=... instead of /adrs/.
 */
import { renderMarkdown } from "@joelclaw/mdx-pipeline/render";

/**
 * Render vault markdown to HTML with Obsidian-flavored features.
 * Wikilinks resolve to vault navigation paths.
 */
export async function renderVaultMarkdown(
  markdown: string,
  allPaths: Set<string> = new Set()
): Promise<string> {
  return renderMarkdown(markdown, {
    resolveLink: (target) => {
      const targetLower = target.toLowerCase().trim();
      for (const p of allPaths) {
        const fileName = p.split("/").pop()?.replace(".md", "") || "";
        if (fileName.toLowerCase() === targetLower) {
          return `/vault/${p}`;
        }
      }
      // Unresolved — fall back to search
      return `/vault?q=${encodeURIComponent(target)}`;
    },
    resolveImage: (target) => `/images/${encodeURI(target)}`,
  });
}
