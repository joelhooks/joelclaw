import { visit } from "unist-util-visit";
import type { Root, Link } from "mdast";
import fs from "fs";
import path from "path";
import { SITE_URL } from "./constants";

const contentDir = path.join(process.cwd(), "content");

/** Build set of valid post slugs from content directory */
function buildSlugSet(): Set<string> {
  const set = new Set<string>();
  try {
    for (const file of fs.readdirSync(contentDir)) {
      if (file.endsWith(".mdx")) {
        set.add(file.replace(/\.mdx$/, ""));
      }
    }
  } catch {}
  return set;
}

let slugSet: Set<string> | null = null;
function getSlugSet() {
  if (!slugSet) slugSet = buildSlugSet();
  return slugSet;
}

/**
 * Remark plugin for markdown output routes:
 * - Rewrites internal post links to their /md endpoint
 * - Rewrites ADR links to absolute URLs
 * - Makes all other internal links absolute
 *
 * Use in /md route remark pipeline, NOT in the HTML pipeline.
 */
export function remarkMdLinks() {
  return (tree: Root) => {
    const slugs = getSlugSet();

    visit(tree, "link", (node: Link) => {
      const url = node.url;
      // Only process internal links
      if (!url.startsWith("/")) return;

      // Parse the path and anchor
      const parts = url.split("#", 2);
      const cleanPath = (parts[0] ?? "").replace(/^\//, "");
      const anchor = parts[1];
      const anchorSuffix = anchor ? `#${anchor}` : "";

      // Post slugs → /md markdown endpoint
      if (slugs.has(cleanPath)) {
        node.url = `${SITE_URL}/${cleanPath}/md${anchorSuffix}`;
        return;
      }

      // ADR links and everything else → absolute URL
      node.url = `${SITE_URL}/${cleanPath}${anchorSuffix}`;
    });
  };
}
