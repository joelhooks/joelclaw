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
  allPaths: Set<string> = new Set(),
  notePath?: string
): Promise<string> {
  // Rewrite relative image paths to API routes
  let processed = markdown;
  if (notePath) {
    const noteDir = notePath.split("/").slice(0, -1).join("/");
    // Match markdown images: ![alt](relative/path.ext)
    processed = processed.replace(
      /!\[([^\]]*)\]\((?!https?:\/\/|\/)(.*?)\)/g,
      (_match, alt, src) => {
        const resolvedPath = noteDir ? `${noteDir}/${src}` : src;
        return `![${alt}](/api/vault/image/${encodeURI(resolvedPath)})`;
      }
    );
  }

  return renderMarkdown(processed, {
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
    resolveImage: (target) => `/api/vault/image/${encodeURI(target)}`,
  });
}
