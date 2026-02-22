import fs from "fs";
import path from "path";
import matter from "gray-matter";

export type DiscoveryMeta = {
  title: string;
  slug: string;
  source: string;
  discovered: string;
  tags: string[];
  relevance: string;
  /** File mtime epoch ms — used for sort tiebreaking within same date */
  _mtime?: number;
};

const discoveriesDir = path.join(process.cwd(), "content", "discoveries");

export function getAllDiscoveries(): DiscoveryMeta[] {
  if (!fs.existsSync(discoveriesDir)) return [];
  const files = fs
    .readdirSync(discoveriesDir)
    .filter((f) => f.endsWith(".md"));

  return files
    .map((filename) => {
      const filePath = path.join(discoveriesDir, filename);
      const raw = fs.readFileSync(filePath, "utf-8");
      const mtime = fs.statSync(filePath).mtimeMs;
      const { data, content } = matter(raw);

      // Title from frontmatter, H1, or filename
      const h1 = content.match(/^#\s+(.+)$/m);
      const title =
        typeof data.title === "string"
          ? data.title
          : h1?.[1]?.trim() ?? filename.replace(/\.md$/, "");

      const slug =
        typeof data.slug === "string"
          ? data.slug
          : filename
              .replace(/\.md$/, "")
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-|-$/g, "");

      return {
        title,
        slug,
        source: (data.source as string) ?? "",
        discovered: (data.discovered as string) ?? "",
        tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
        relevance: (data.relevance as string) ?? "",
        _mtime: mtime,
      };
    })
    .sort((a, b) => {
      // Primary: discovered date descending
      if (a.discovered !== b.discovered)
        return a.discovered > b.discovered ? -1 : 1;
      // Secondary: file mtime descending (newest first)
      return (b._mtime ?? 0) - (a._mtime ?? 0);
    });
}

export function getDiscovery(slug: string) {
  if (!fs.existsSync(discoveriesDir)) return null;

  // Find by slug in frontmatter or by filename match
  const files = fs.readdirSync(discoveriesDir).filter((f) => f.endsWith(".md"));

  for (const filename of files) {
    const raw = fs.readFileSync(path.join(discoveriesDir, filename), "utf-8");
    const { data, content } = matter(raw);

    const fileSlug =
      typeof data.slug === "string"
        ? data.slug
        : filename
            .replace(/\.md$/, "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "");

    if (fileSlug === slug) {
      const h1 = content.match(/^#\s+(.+)$/m);
      const title =
        typeof data.title === "string"
          ? data.title
          : h1?.[1]?.trim() ?? filename.replace(/\.md$/, "");

      // Strip the first H1 from content — the page template renders it from frontmatter
      const strippedContent = content.replace(/^#\s+.+\n*/m, "");

      return {
        meta: {
          title,
          slug: fileSlug,
          source: (data.source as string) ?? "",
          discovered: (data.discovered as string) ?? "",
          tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
          relevance: (data.relevance as string) ?? "",
        } satisfies DiscoveryMeta,
        content: strippedContent,
      };
    }
  }

  return null;
}

export function getDiscoverySlugs(): string[] {
  if (!fs.existsSync(discoveriesDir)) return [];
  return fs
    .readdirSync(discoveriesDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const raw = fs.readFileSync(path.join(discoveriesDir, f), "utf-8");
      const { data } = matter(raw);
      return typeof data.slug === "string"
        ? data.slug
        : f
            .replace(/\.md$/, "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "");
    });
}
