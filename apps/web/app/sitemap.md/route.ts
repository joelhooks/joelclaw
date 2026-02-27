import { getAllPosts } from "@/lib/posts";
import { getAllAdrs } from "@/lib/adrs";
import { SITE_URL, SITE_NAME, SITE_DESCRIPTION, AUTHOR } from "@/lib/constants";

export function GET() {
  const posts = getAllPosts();
  const adrs = getAllAdrs();

  const lines: string[] = [
    `# ${SITE_NAME}`,
    "",
    `> ${SITE_DESCRIPTION}`,
    "",
    `By [${AUTHOR.name}](${SITE_URL})`,
    "",
    "## Posts",
    "",
    ...posts.map(
      (p) => `- [${p.title}](${SITE_URL}/${p.slug}) — ${p.description}`
    ),
    "",
    "## Architecture Decision Records",
    "",
    ...adrs.map(
      (a) =>
        `- [ADR-${a.number}: ${a.title}](${SITE_URL}/adrs/${a.slug}) (${a.status})${a.description ? ` — ${a.description}` : ""}`
    ),
    "",
    "## Feeds",
    "",
    `- [RSS Feed](${SITE_URL}/feed.xml)`,
    `- [Sitemap XML](${SITE_URL}/sitemap.xml)`,
    `- [Sitemap Markdown](${SITE_URL}/sitemap.md)`,
    "",
    "## Agent Markdown Exports",
    "",
    "Append `.md` for agent markdown with preamble + implementation details:",
    "",
    ...posts.map((p) => `- [${p.title}](${SITE_URL}/${p.slug}.md)`),
    "",
  ];

  return new Response(lines.join("\n"), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "s-maxage=3600, stale-while-revalidate",
    },
  });
}
