import { SITE_URL, SITE_NAME, SITE_DESCRIPTION, AUTHOR } from "../../lib/constants";

export function GET() {
  const lines = [
    `# ${SITE_NAME}`,
    "",
    `> ${SITE_DESCRIPTION}`,
    "",
    `Author: ${AUTHOR.name}`,
    `URL: ${SITE_URL}`,
    "",
    "## About",
    "",
    "JoelClaw is a personal AI operating system built on a Mac Mini.",
    "This site documents the architecture, decisions, and lessons learned",
    "from building an always-on AI assistant from scratch.",
    "",
    "Topics: personal AI systems, agent architecture, OpenClaw, AT Protocol,",
    "Inngest event-driven workflows, memory systems, autonomous coding loops.",
    "",
    "## Content",
    "",
    `- Sitemap (markdown): ${SITE_URL}/sitemap.md`,
    `- Sitemap (XML): ${SITE_URL}/sitemap.xml`,
    `- RSS Feed: ${SITE_URL}/feed.xml`,
    "",
    "## Markdown access",
    "",
    "All posts are available as clean markdown by appending /md to the URL.",
    `Example: ${SITE_URL}/building-my-own-openclaw/md`,
    "",
  ];

  return new Response(lines.join("\n"), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "s-maxage=3600, stale-while-revalidate",
    },
  });
}
