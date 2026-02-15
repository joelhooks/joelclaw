import { visit } from "unist-util-visit";
import type { Root, Link, Text } from "mdast";
import fs from "fs";
import path from "path";

const ADR_REF = /ADR-(\d{4})/g;

/** Build a map of ADR number → slug from the content/adrs directory */
function buildAdrMap(): Map<string, string> {
  const map = new Map<string, string>();
  const dir = path.join(process.cwd(), "content", "adrs");
  if (!fs.existsSync(dir)) return map;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".md") || file === "README.md") continue;
    const slug = file.replace(/\.md$/, "");
    const num = slug.match(/^(\d+)/)?.[1];
    if (num) map.set(num, slug);
  }
  return map;
}

let adrMap: Map<string, string> | null = null;
function getAdrMap() {
  if (!adrMap) adrMap = buildAdrMap();
  return adrMap;
}

/**
 * Remark plugin for ADR cross-references:
 * 1. Rewrites relative .md links (e.g. 0005-foo.md) to /adrs/0005-foo
 * 2. Auto-links bare "ADR-NNNN" text to /adrs/NNNN-slug
 */
export function remarkAdrLinks() {
  return (tree: Root) => {
    const map = getAdrMap();

    // Pass 1: rewrite relative .md links to /adrs/ routes
    visit(tree, "link", (node: Link) => {
      const url = node.url;
      if (url.match(/^\d{4}-.*\.md$/)) {
        node.url = `/adrs/${url.replace(/\.md$/, "")}`;
      }
    });

    // Pass 2: auto-link bare ADR-NNNN references in text nodes
    visit(tree, "text", (node: Text, index, parent) => {
      if (!parent || index === undefined) return;
      // Skip if already inside a link
      if (parent.type === "link") return;

      const text = node.value;
      if (!ADR_REF.test(text)) return;
      ADR_REF.lastIndex = 0;

      const children: (Text | Link)[] = [];
      let lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = ADR_REF.exec(text)) !== null) {
        const num = match[1];
        const slug: string | undefined = map.get(num);
        if (!slug) continue;

        // Text before the match
        if (match.index > lastIndex) {
          children.push({
            type: "text",
            value: text.slice(lastIndex, match.index),
          });
        }

        // The ADR link
        children.push({
          type: "link",
          url: `/adrs/${slug}`,
          children: [{ type: "text", value: match[0] }],
        });

        lastIndex = match.index + match[0].length;
      }

      if (children.length === 0) return;

      // Trailing text
      if (lastIndex < text.length) {
        children.push({ type: "text", value: text.slice(lastIndex) });
      }

      // Replace the text node with the new children
      parent.children.splice(index, 1, ...children);
    });
  };
}
