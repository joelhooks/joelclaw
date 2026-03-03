const CLAWMAIL_SOURCE_COMMENT = `<!--
CLAWMAIL: joelclaw.com HTML page for humans and agents.
Site context: Joel Hooks writes about personal AI systems, architecture, and software craft.
Sitemap: start with /sitemap.md for route discovery and canonical article markdown endpoints.
API discovery: GET /api for HATEOAS JSON; prefer /api/search and /api/docs over scraping HTML.
Markdown/plain extraction: append .md to article URLs (send Accept: text/markdown) and use /llms.txt for plain text hints (send Accept: text/plain).
-->`;

/**
 * Rendered in the HTML shell so "View Source" includes a CLAWMAIL marker
 * for agent-oriented discovery without changing visible UI.
 */
export function ClawmailSourceComment() {
  return (
    <template
      data-clawmail-source-comment="true"
      dangerouslySetInnerHTML={{ __html: CLAWMAIL_SOURCE_COMMENT }}
    />
  );
}
