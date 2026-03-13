---
name: google-docs-md
displayName: Google Docs Markdown Export
description: Export Google Docs as clean markdown via native URL parameter. No auth needed for public docs. Use when fetching Google Doc content for vault ingestion, runbook building, or any doc-to-markdown pipeline.
version: 0.1.0
author: joel
tags:
  - google-docs
  - markdown
  - export
  - content-extraction
---

# Google Docs Markdown Export

Google Docs natively supports markdown export via a URL parameter. This is the most reliable way to get markdown from a Google Doc — better than defuddle, jina, or any scraping tool.

## URL Pattern

For any Google Doc URL like:
```
https://docs.google.com/document/d/{DOC_ID}/edit?tab=t.0
```

Replace everything after the document ID with `export?format=md`:
```
https://docs.google.com/document/d/{DOC_ID}/export?format=md
```

## Extracting the Document ID

The DOC_ID is the long alphanumeric string between `/d/` and the next `/`:

```bash
# From any Google Docs URL, extract the ID:
echo "https://docs.google.com/document/d/1mt8aYM88Jj5qkep1xYC5vj0wBlbX2u6gdxhf_puaiQI/edit?tab=t.0" \
  | grep -oP '(?<=/d/)[^/]+'
# → 1mt8aYM88Jj5qkep1xYC5vj0wBlbX2u6gdxhf_puaiQI
```

## Fetching

```bash
# Public docs — no auth needed, follow the 307 redirect:
curl -L "https://docs.google.com/document/d/${DOC_ID}/export?format=md" -o output.md

# Private docs — needs OAuth bearer token:
curl -L "https://docs.google.com/document/d/${DOC_ID}/export?format=md" \
  -H "Authorization: Bearer ${TOKEN}" -o output.md
```

**Important:** The endpoint returns a `307` redirect. Always use `curl -L` (follow redirects) or equivalent.

## Other Export Formats

The same pattern works for other formats:
- `export?format=pdf` — PDF
- `export?format=docx` — Word
- `export?format=txt` — Plain text
- `export?format=html` — HTML
- `export?format=epub` — ePub

## Batch Pattern

When you have a list of Google Doc URLs (e.g. extracted from Front emails):

```bash
# Extract doc IDs from a file of URLs
grep -oP '(?<=/d/)[^/]+' urls.txt | sort -u | while read id; do
  echo "Fetching $id..."
  curl -sL "https://docs.google.com/document/d/${id}/export?format=md" \
    -o "docs/${id}.md"
  sleep 1  # Be polite
done
```

## When to Use

- **Always prefer this** over defuddle/scraping for Google Docs
- Works for public docs without any authentication
- Native markdown quality is superior to any HTML→markdown conversion
- Handles tables, formatting, links, images (as URLs) correctly

## Limitations

- Private docs require a valid OAuth token (use `gog` when available)
- Very large docs may take a few seconds
- Images are referenced as URLs, not embedded
- Comments and suggestions are not included in the export
