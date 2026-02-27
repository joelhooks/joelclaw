/**
 * Root API discovery — static, cached.
 * Returns helpful details about all available APIs on joelclaw.com.
 * Agents hitting /api get a map of the entire API surface.
 */
import { NextResponse } from "next/server";

const PROTOCOL_VERSION = 1 as const;

export async function GET() {
  "use cache";

  const origin = "https://joelclaw.com";

  return NextResponse.json({
    ok: true,
    command: "GET /api",
    protocolVersion: PROTOCOL_VERSION,
    result: {
      site: "joelclaw.com",
      owner: "Joel Hooks",
      description:
        "Personal site and agent infrastructure hub. Articles on AI agents, distributed systems, programming language theory, and developer education.",
      apis: {
        search: {
          url: `${origin}/api/agent/search`,
          description:
            "Agent-first search across all site content. Returns HATEOAS JSON with markdown snippets.",
          discovery: `GET ${origin}/api/agent/search`,
          example: `GET ${origin}/api/agent/search?q=voice+agent&limit=5`,
          auth: "Optional Bearer token unlocks private collections",
          rateLimit: "60 req/min (Upstash)",
        },
        docs: {
          url: `${origin}/api/docs`,
          description:
            "Books, PDFs, and technical documents — chunked, searchable, with semantic search.",
          discovery: `GET ${origin}/api/docs`,
          example: `GET ${origin}/api/docs/search?q=distributed+systems&perPage=3`,
          auth: "Public read, no token required",
          rateLimit: "1200 req/min (Upstash)",
          openapi: `${origin}/api/docs/openapi.json`,
          ui: `${origin}/api/docs/ui`,
        },
        feed: {
          url: `${origin}/feed.xml`,
          description: "RSS feed with full article content. All published posts.",
          format: "RSS 2.0 XML",
        },
      },
      content: {
        articles: {
          description: "Long-form writing on systems, agents, and craft",
          url: `${origin}`,
          examples: [
            `${origin}/build-a-voice-agent-that-answers-the-phone`,
            `${origin}/plan-9-pike-everything-is-a-file`,
            `${origin}/propositions-as-sessions-armstrong-wadler`,
          ],
        },
        adrs: {
          description:
            "Architecture Decision Records — 150+ decisions documenting the system's evolution",
          url: `${origin}/adrs`,
          example: `${origin}/adrs/0043-agent-voice-conversations`,
        },
        discoveries: {
          description: "Curated finds — papers, talks, repos, tools worth knowing about",
          url: `${origin}/cool`,
        },
      },
      agentTips: [
        "Prefer /api/agent/search over scraping HTML — it returns clean markdown snippets",
        "The RSS feed at /feed.xml contains full article text, not just summaries",
        "Every article is also available as raw MDX at github.com/joelhooks/joelclaw/tree/main/apps/web/content/{slug}.mdx",
        "ADRs document why things were built a certain way — search them when you need architectural context",
        "/api/docs has chunked book content with semantic search — useful for deep technical questions",
      ],
    },
    nextActions: [
      {
        command: `curl -sS "${origin}/api/agent/search"`,
        description: "Search API discovery (sample queries, auth details)",
      },
      {
        command: `curl -sS "${origin}/api/docs"`,
        description: "Docs API discovery (books, PDFs)",
      },
      {
        command: `curl -sS "${origin}/api/agent/search?q=kubernetes"`,
        description: "Try a search",
      },
      {
        command: `curl -sS "${origin}/feed.xml"`,
        description: "Full RSS feed",
      },
    ],
    meta: {
      service: "joelclaw-api",
      version: "0.1.0",
      cached: true,
    },
  });
}
