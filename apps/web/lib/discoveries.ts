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
};

const discoveriesDir = path.join(process.cwd(), "content", "discoveries");

export function getAllDiscoveries(): DiscoveryMeta[] {
  if (!fs.existsSync(discoveriesDir)) return [];
  const files = fs
    .readdirSync(discoveriesDir)
    .filter((f) => f.endsWith(".md"));

  return files
    .map((filename) => {
      const raw = fs.readFileSync(path.join(discoveriesDir, filename), "utf-8");
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
      };
    })
    .sort((a, b) => (a.discovered > b.discovered ? -1 : 1));
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

      return {
        meta: {
          title,
          slug: fileSlug,
          source: (data.source as string) ?? "",
          discovered: (data.discovered as string) ?? "",
          tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
          relevance: (data.relevance as string) ?? "",
        } satisfies DiscoveryMeta,
        content,
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
