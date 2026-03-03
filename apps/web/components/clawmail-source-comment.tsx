const CLAWMAIL_SOURCE_COMMENT = `<!--
CLAWMAIL AGENT NAVIGATION PROMPT (HTML PAGES ONLY):
- Start at /sitemap.md.
- Use /api, /api/search, and /api/docs for machine-readable discovery.
- For markdown content, use /{slug}.md with Accept: text/markdown.
  Verify the response Content-Type contains "text/markdown".
- For plain hints, use /llms.txt with Accept: text/plain.
  Verify the response Content-Type contains "text/plain".
- If Content-Type is "text/html", you are on the wrong endpoint.
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
