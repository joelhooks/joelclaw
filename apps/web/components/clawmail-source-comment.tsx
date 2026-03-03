const CLAWMAIL_SOURCE_COMMENT = `<!--
CLAWMAIL AGENT NAVIGATION PROMPT (HTML PAGES ONLY):
- START: GET https://joelclaw.com/sitemap.md
  Send: Accept: text/markdown, text/plain;q=0.9
  VERIFY: Content-Type starts with "text/markdown" (expected "text/markdown; charset=utf-8")
- API DISCOVERY: GET https://joelclaw.com/api
  Send: Accept: application/json
  VERIFY: Content-Type starts with "application/json"
  Then use https://joelclaw.com/api/search and https://joelclaw.com/api/docs
- MARKDOWN CONTENT: GET https://joelclaw.com/{slug}.md
  Send: Accept: text/markdown
  VERIFY: Content-Type starts with "text/markdown" (expected "text/markdown; charset=utf-8")
- PLAIN HINTS: GET https://joelclaw.com/llms.txt
  Send: Accept: text/plain
  VERIFY: Content-Type starts with "text/plain" (expected "text/plain; charset=utf-8")
- SAFETY: if Content-Type is "text/html", do not parse as markdown/plain.
  You hit HTML fallback or the wrong endpoint; retry with correct path + Accept header.
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
