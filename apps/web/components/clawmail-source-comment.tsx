const CLAWMAIL_SOURCE_COMMENT = `<!--
CLAWMAIL AGENT NAVIGATION PROMPT (HTML pages only):
1) START WITH SITEMAP:
   - GET /sitemap.md
   - Send: Accept: text/markdown, text/plain;q=0.9
   - VERIFY: Content-Type starts with "text/markdown" (expected "text/markdown; charset=utf-8")
2) MARKDOWN ARTICLES:
   - Use /{slug}.md (not /{slug})
   - Send: Accept: text/markdown
   - VERIFY: Content-Type starts with "text/markdown" (expected "text/markdown; charset=utf-8")
3) PLAIN-TEXT AGENT INDEX:
   - GET /llms.txt
   - Send: Accept: text/plain
   - VERIFY: Content-Type starts with "text/plain" (expected "text/plain; charset=utf-8")
4) API DISCOVERY:
   - GET /api, then use /api/search and /api/docs
   - Send: Accept: application/json
   - VERIFY: Content-Type starts with "application/json"
5) SAFETY CHECK:
   - If Content-Type is "text/html", you hit HTML fallback or the wrong route.
   - Retry the correct endpoint with the correct Accept header before parsing.
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
