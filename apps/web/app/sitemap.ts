import type { MetadataRoute } from "next";
import { getAllPosts } from "../lib/posts";
import { getAllAdrs } from "../lib/adrs";
import { SITE_URL } from "../lib/constants";
import { parseDateValue } from "../lib/date";

function getLastModified(...candidates: unknown[]): Date {
  for (const candidate of candidates) {
    const parsed = parseDateValue(candidate);
    if (parsed) return parsed;
  }
  return new Date();
}

export default function sitemap(): MetadataRoute.Sitemap {
  const posts = getAllPosts();
  const adrs = getAllAdrs();

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
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 1,
    },
    ...postEntries,
    {
      url: `${SITE_URL}/adrs`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.6,
    },
    ...adrEntries,
    ...agentMarkdownEntries,
  ];
}
