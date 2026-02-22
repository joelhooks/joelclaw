/**
 * rehype-paragraph-ids — stable paragraph-level IDs for comment anchoring.
 *
 * ADR-0106: Adds `id` and `data-paragraph-id` to block-level elements.
 * - Headings: slugified text content (e.g. "context" for "## Context")
 * - Paragraphs, blockquotes, list items: "p-" + first 8 chars of SHA-256
 *
 * IDs are content-deterministic — same text always produces same ID.
 * This means comment anchors survive whitespace-only edits.
 */
import { visit } from "unist-util-visit";
import { createHash } from "node:crypto";
import type { Root, Element } from "hast";
import { toString } from "hast-util-to-string";

const COMMENTABLE_TAGS = new Set([
  "p",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "li",
  "blockquote",
]);

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function contentHash(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex").slice(0, 8);
}

export function rehypeParagraphIds() {
  return (tree: Root) => {
    const usedIds = new Set<string>();

    visit(tree, "element", (node: Element) => {
      if (!COMMENTABLE_TAGS.has(node.tagName)) return;

      const text = toString(node);
      if (!text.trim()) return;

      let id: string;
      if (node.tagName.startsWith("h")) {
        // Headings get slugified text
        id = slugify(text);
      } else {
        // Everything else gets a content hash
        id = `p-${contentHash(text)}`;
      }

      // Deduplicate (multiple paragraphs with identical text)
      if (usedIds.has(id)) {
        let suffix = 2;
        while (usedIds.has(`${id}-${suffix}`)) suffix++;
        id = `${id}-${suffix}`;
      }
      usedIds.add(id);

      // Don't overwrite existing ids (rehype-slug already handles headings)
      node.properties ??= {};
      if (!node.properties.id) {
        node.properties.id = id;
      }
      node.properties["dataParagraphId"] = node.properties.id as string;
    });
  };
}
