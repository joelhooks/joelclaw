import { getAllPosts } from "@/lib/posts";
import { getAllAdrs } from "@/lib/adrs";
import { getAllDiscoveries } from "@/lib/discoveries";
import { SITE_URL, SITE_NAME, SITE_DESCRIPTION, AUTHOR } from "@/lib/constants";
import { formatRssPubDate } from "@/lib/date";

export async function GET() {
  const posts = await getAllPosts();
  const adrs = getAllAdrs();
  const discoveries = getAllDiscoveries();

  const postItems = posts.map((post) => ({
    title: post.title,
    link: `${SITE_URL}/${post.slug}`,
    description: post.description,
    date: post.updated ?? post.date,
    category: "post",
  }));

  const adrItems = adrs.map((adr) => ({
    title: `ADR-${adr.number}: ${adr.title}`,
    link: `${SITE_URL}/adrs/${adr.slug}`,
    description: `[${adr.status}] ${adr.description ?? adr.title}`,
    date: adr.date,
    category: "adr",
  }));

  const discoveryItems = discoveries.map((d) => ({
    title: d.title,
    link: `${SITE_URL}/cool/${d.slug}`,
    description: `[${d.tags.join(", ")}] ${d.relevance ?? d.title}`,
    date: d.discovered,
    category: "discovery",
  }));

  const allItems = [...postItems, ...adrItems, ...discoveryItems]
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const items = allItems
    .map(
      (item) => `
    <item>
      <title><![CDATA[${item.title}]]></title>
      <link>${item.link}</link>
      <guid isPermaLink="true">${item.link}</guid>
      <description><![CDATA[${item.description}]]></description>
      <pubDate>${formatRssPubDate(item.date)}</pubDate>
      <category>${item.category}</category>
    </item>`,
    )
    .join("\n");

  const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${SITE_NAME}</title>
    <link>${SITE_URL}</link>
    <description>${SITE_DESCRIPTION}</description>
    <language>en-us</language>
    <managingEditor>${AUTHOR.name}</managingEditor>
    <atom:link href="${SITE_URL}/feed.xml" rel="self" type="application/rss+xml" />
    ${items}
  </channel>
</rss>`;

  return new Response(feed, {
    headers: {
      "Content-Type": "application/xml",
      "Cache-Control": "s-maxage=3600, stale-while-revalidate",
    },
  });
}
