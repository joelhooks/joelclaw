---
name: content-publish
displayName: Content Publish
description: "Publish content to joelclaw.com via the Convex-first pipeline. Covers the full lifecycle: draft → review → publish → revalidate → verify. Handles secret leasing, tag conventions, content types (article, tutorial, note, essay), and verification gates. Use when: 'write article about X', 'publish article <slug>', 'draft a tutorial', 'publish this', 'push to convex', or any content publishing task."
version: 0.1.0
author: joel
tags:
  - content
  - convex
  - publishing
  - web
---

# Content Publish

Publish content to joelclaw.com through the Convex-first pipeline. Every article, tutorial, note, and essay flows through this skill.

## Content Types

| Type | `fields.type` | When to use |
|------|--------------|-------------|
| article | `article` | Standard blog post, opinion, narrative |
| tutorial | `tutorial` | Implementable spec — agent or human can build from it |
| note | `note` | Short observation, link commentary, video note |
| essay | `essay` | Long-form, thesis-driven |

**Tags must include the content type.** A tutorial gets `tags: [..., "tutorial"]`. An essay gets `tags: [..., "essay"]`. This enables filtered views and search facets.

## Lifecycle

### 1. Draft

Upsert to Convex with `draft: true`:

```bash
npx convex run contentResources:upsert '<JSON>'
```

Required fields:
```json
{
  "resourceId": "article:<slug>",
  "type": "article",
  "fields": {
    "title": "The Title",
    "slug": "the-slug",
    "description": "One-liner for cards and meta",
    "date": "2026-03-02T10:14:00.000Z",
    "tags": ["topic1", "topic2", "tutorial"],
    "draft": true,
    "content": "Full MDX body (frontmatter stripped)"
  }
}
```

**Slug rules**: lowercase, hyphenated, no special chars. Derived from title. Check for collisions first:
```bash
npx convex run contentResources:getByResourceId '{"resourceId": "article:<slug>"}'
```

**Date**: Full ISO datetime, not bare date. Determines sort order.

**Content**: Strip any frontmatter from MDX before setting `fields.content`. The frontmatter fields are stored as separate Convex fields, not inline.

### 2. Content preparation

For large content, prepare the JSON payload with Node to handle escaping:

```bash
cd ~/Code/joelhooks/joelclaw/apps/web

node -e "
const fs = require('fs');
const content = fs.readFileSync('<path-to-mdx>', 'utf-8')
  .replace(/^---[\\\\s\\\\S]*?---\\\\n/, '').trim();
const args = {
  resourceId: 'article:<slug>',
  type: 'article',
  fields: {
    title: '<title>',
    slug: '<slug>',
    description: '<description>',
    date: '<ISO datetime>',
    tags: [<tags>],
    draft: true,
    content: content,
  },
};
fs.writeFileSync('/tmp/convex-args.json', JSON.stringify(args));
"

npx convex run contentResources:upsert \"\$(cat /tmp/convex-args.json)\"
```

**Always run `npx convex` from `apps/web/`** — that's where the Convex config and generated API types live.

### 3. Review

Drafts are visible in dev only (`NODE_ENV === "development"`). Preview at `localhost:3000/<slug>`.

Drafts return 404 in production — this is correct. Do not publish without review confirmation from Joel unless the content was explicitly pre-approved.

### 4. Publish

Update the document with `draft: false` and set `updated` timestamp:

```bash
# Re-run the upsert with draft: false
# Add fields.updated = current ISO datetime
```

### 5. Revalidate

Lease the revalidation secret and hit the API:

```bash
# Lease secret (TTL auto-managed)
SECRET=$(joelclaw secrets lease revalidation_secret)

curl -s -X POST "https://joelclaw.com/api/revalidate" \
  -H "Content-Type: application/json" \
  -d "{
    \"secret\": \"$SECRET\",
    \"tags\": [\"post:<slug>\", \"article:<slug>\", \"articles\"],
    \"paths\": [\"/\", \"/<slug>\", \"/<slug>.md\", \"/<slug>/md\", \"/feed.xml\", \"/sitemap.md\"]
  }"
```

Expected response: `{"revalidated": true, ...}`

**Tag convention**:
- `post:<slug>` — individual post cache
- `article:<slug>` — content resource cache
- `articles` — list page cache
- Always include all three tags + the markdown/feed/sitemap paths

### 6. Verify

```bash
# Must return 200
curl -s -o /dev/null -w "%{http_code}" "https://joelclaw.com/<slug>"

# Markdown twin must return 200 and current content
curl -s -o /dev/null -w "%{http_code}" "https://joelclaw.com/<slug>.md"

# Must appear on homepage
curl -s "https://joelclaw.com" | grep -c "<slug>"

# Feed should include it
curl -s "https://joelclaw.com/feed.xml" | grep -c "<slug>"
```

All four checks must pass. If the slug page returns 404 after revalidation, the Convex document is likely still `draft: true` or content is missing.

## Updating existing content

Same upsert flow. Set `fields.updated` to bump sort position. Always revalidate after update.

## Gotchas

- **Convex CLI must run from `apps/web/`** — it needs the project config
- **Content must have frontmatter stripped** — Convex fields ARE the metadata; don't duplicate in content body
- **ISO datetimes, not bare dates** — `2026-03-02T10:14:00.000Z` not `2026-03-02`
- **Secret is ephemeral** — lease from `agent-secrets`, never hardcode or cache
- **Large content needs JSON escaping** — use Node script to build payload, not manual string interpolation
- **Tags must include content type** — tutorials get `"tutorial"` tag, essays get `"essay"` tag
- **The filesystem `content/` directory is gitignored seed material** — Convex is the source of truth at runtime
