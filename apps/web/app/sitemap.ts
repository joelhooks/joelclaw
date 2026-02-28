import type { MetadataRoute } from "next";
import { getAllAdrs } from "@/lib/adrs";
import { SITE_URL } from "@/lib/constants";
import { toDateString } from "@/lib/date";
import { getAllPosts } from "@/lib/posts";

function getLastModified(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    const parsed = toDateString(candidate);
    if (parsed) return parsed;
  }
  return "2026-01-01T00:00:00.000Z";
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const posts = await getAllPosts();
  const adrs = await getAllAdrs();

  const postEntries = posts.map((post) => ({
    url: `${SITE_URL}/${post.slug}`,
    lastModified: getLastModified(post.updated, post.date),
    changeFrequency: "monthly" as const,
    priority: 0.8,
  }));

  const agentMarkdownEntries = posts.map((post) => ({
    url: `${SITE_URL}/${post.slug}.md`,
    lastModified: getLastModified(post.updated, post.date),
    changeFrequency: "monthly" as const,
    priority: 0.3,
  }));

  const adrEntries = adrs.map((adr) => ({
    url: `${SITE_URL}/adrs/${adr.slug}`,
    lastModified: getLastModified(adr.date),
    changeFrequency: "monthly" as const,
    priority: 0.5,
  }));

  return [
    {
      url: SITE_URL,
      lastModified: "2026-01-01T00:00:00.000Z",
      changeFrequency: "weekly",
      priority: 1,
    },
    ...postEntries,
    {
      url: `${SITE_URL}/adrs`,
      lastModified: "2026-01-01T00:00:00.000Z",
      changeFrequency: "weekly",
      priority: 0.6,
    },
    ...adrEntries,
    ...agentMarkdownEntries,
  ];
}
