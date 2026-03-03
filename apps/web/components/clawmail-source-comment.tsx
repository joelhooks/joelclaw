const CLAWMAIL_SOURCE_COMMENT = `<!--
CLAWMAIL AGENT NAVIGATION PROMPT (HTML PAGES ONLY):
- Start at https://joelclaw.com/sitemap.md.
- Use https://joelclaw.com/api, https://joelclaw.com/api/search, and https://joelclaw.com/api/docs for machine-readable discovery.
- For markdown content, use https://joelclaw.com/{slug}.md with Accept: text/markdown.
  Verify the response Content-Type contains "text/markdown".
- For plain hints, use https://joelclaw.com/llms.txt with Accept: text/plain.
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
