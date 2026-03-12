---
name: ahrefs
displayName: Ahrefs SEO Tools
description: Query Ahrefs SEO data via their MCP server — keyword research, site explorer, SERP analysis, competitor research, backlink analysis, and Brand Radar AI visibility. Use when researching keywords, analyzing competitors, checking backlinks, auditing sites, or any SEO data task. Triggers on 'keyword research', 'check backlinks', 'competitor analysis', 'ahrefs', 'search volume', 'keyword difficulty', 'domain rating', 'SERP analysis', 'SEO data', 'brand radar', or any request needing search engine optimization data.
version: 0.1.0
author: joel
tags:
  - seo
  - research
  - marketing
  - keywords
  - mcp
---

# Ahrefs SEO Tools

Query Ahrefs via their remote MCP server (Streamable HTTP transport). Joel has a **Standard plan** ($249/mo).

## Connection

**Endpoint:** `https://api.ahrefs.com/mcp/mcp`
**Auth:** Bearer token via `agent-secrets lease ahrefs_api_key`
**Transport:** Streamable HTTP (JSON-RPC over POST, NOT SSE)
**Config:** `~/.pi/agent/mcp.json` under `ahrefs` key

### Raw curl pattern (when MCP bridge isn't available)

```bash
AHREFS_KEY=$(agent-secrets lease ahrefs_api_key --ttl 4h --json 2>&1 | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['value'])")

curl -s -X POST "https://api.ahrefs.com/mcp/mcp" \
  -H "Authorization: Bearer $AHREFS_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{
    "jsonrpc":"2.0","id":1,"method":"tools/call",
    "params":{"name":"TOOL_NAME","arguments":{...}}
  }'
```

### MCP initialization handshake (required once per session)

```json
{"jsonrpc":"2.0","id":0,"method":"initialize","params":{
  "protocolVersion":"2025-03-26",
  "capabilities":{},
  "clientInfo":{"name":"pi","version":"1.0"}
}}
```

## Critical: Use `doc` tool first

Before calling any data tool for the first time, call the `doc` tool to get the real input schema:

```json
{"name":"doc","arguments":{"tool":"keywords-explorer-overview"}}
```

This returns the full schema with field names, types, filter syntax, and output columns. **The tool list schemas are summaries — `doc` gives the real contract.**

## API Units

Every call costs API units. The response includes cost info:
```json
{"apiUsageCosts":{"rows":10,"units-cost-row":21,"units-cost-total":210}}
```

- Monetary values (CPC, traffic_value, etc.) are in **USD cents**, not dollars. Divide by 100.
- `difficulty` costs 10 extra units per row when selected
- Standard plan has monthly unit limits — check with `subscription-info-limits-and-usage`

## Tool Categories

### Keywords Explorer (keyword research)

| Tool | Use for | Key required params |
|------|---------|-------------------|
| `keywords-explorer-overview` | Volume, KD, CPC for specific keywords | `select`, `country`, `keywords` (array) |
| `keywords-explorer-matching-terms` | Find keyword ideas matching seed terms | `select`, `country`, `keywords`, `limit`, `order_by` |
| `keywords-explorer-related-terms` | "Also rank for" and "also talk about" | `select`, `country`, `keywords` |
| `keywords-explorer-search-suggestions` | Autocomplete suggestions with metrics | `select`, `country`, `keywords` |
| `keywords-explorer-volume-history` | Historical volume trends | `country`, `keyword` (singular) |
| `keywords-explorer-volume-by-country` | Volume broken down by country | `keyword` (singular) |

**Common `select` fields:** `keyword`, `volume`, `difficulty`, `cpc`, `traffic_potential`, `global_volume`, `parent_topic`, `intents`, `clicks`, `cps`, `serp_features`

**Gotcha:** `keywords-explorer-overview` requires `keywords` as an array BUT returns empty results for broad terms — it only returns data for exact keyword matches in their DB. Use `matching-terms` or `search-suggestions` for discovery.

### Site Explorer (domain/URL analysis)

| Tool | Use for | Key required params |
|------|---------|-------------------|
| `site-explorer-metrics` | DR, traffic, keywords count | `target`, `date` |
| `site-explorer-organic-keywords` | What keywords a site ranks for | `select`, `target`, `date`, `country` |
| `site-explorer-organic-competitors` | Who competes in organic search | `select`, `target`, `country`, `date` |
| `site-explorer-top-pages` | Best pages by traffic | `select`, `target`, `date` |
| `site-explorer-all-backlinks` | Inbound link details | `select`, `target` |
| `site-explorer-referring-domains` | Domains linking to target | `select`, `target` |
| `site-explorer-domain-rating` | DR score | `target`, `date` |
| `site-explorer-domain-rating-history` | DR over time | `target`, `date_from` |
| `site-explorer-backlinks-stats` | Backlink summary stats | `target`, `date` |
| `site-explorer-anchors` | Anchor text analysis | `select`, `target` |
| `site-explorer-broken-backlinks` | Broken inbound links | `select`, `target` |
| `site-explorer-metrics-by-country` | Traffic by country | `target`, `date` |
| `site-explorer-metrics-history` | Historical traffic/keywords | `target`, `date_from` |

**`target`** = domain (`example.com`), URL (`https://example.com/page`), or path (`example.com/blog/*`)
**`mode`** = `exact` | `domain` | `subdomains` | `prefix`
**`date`** = `YYYY-MM-DD` (use recent date like today)

### SERP Analysis

| Tool | Use for | Key required params |
|------|---------|-------------------|
| `serp-overview` | Top results for a keyword | `select`, `country`, `keyword` |

### Batch Analysis

| Tool | Use for | Key required params |
|------|---------|-------------------|
| `batch-analysis` | Analyze multiple URLs/domains at once | `select`, `targets` (array) |

### Rank Tracker (requires project setup in Ahrefs UI)

Tools: `rank-tracker-overview`, `rank-tracker-competitors-*`, `rank-tracker-serp-overview`
All require `project_id` — get via `management-projects`.

### Site Audit (requires project setup in Ahrefs UI)

Tools: `site-audit-issues`, `site-audit-page-explorer`, `site-audit-page-content`, `site-audit-projects`

### Brand Radar (AI visibility monitoring)

Tools: `brand-radar-mentions-*`, `brand-radar-impressions-*`, `brand-radar-sov-*`, `brand-radar-ai-responses`, `brand-radar-cited-*`
Requires brand monitoring setup in Ahrefs UI.

### Web Analytics (requires Ahrefs analytics snippet)

All `web-analytics-*` tools require `project_id` from a Web Analytics project.

### Management

| Tool | Use for |
|------|---------|
| `management-projects` | List all projects |
| `management-project-keywords` | Keywords in a project |
| `management-project-competitors` | Competitors in a project |
| `management-locations` | Location IDs for targeting |
| `management-keyword-list-keywords` | Keywords from a saved list (**free, no units**) |
| `subscription-info-limits-and-usage` | Check remaining API units |

## Common Recipes

### Keyword research for a local service

```bash
# 1. Discover keywords
{"name":"keywords-explorer-matching-terms","arguments":{
  "keywords":["water damage restoration"],
  "select":"keyword,volume,difficulty,cpc,traffic_potential",
  "country":"us",
  "limit":20,
  "order_by":"volume:desc"
}}

# 2. Check specific local terms
{"name":"keywords-explorer-overview","arguments":{
  "keywords":["water damage restoration vancouver wa","water damage portland or"],
  "select":"keyword,volume,difficulty,cpc",
  "country":"us"
}}
```

### Competitor analysis

```bash
# 1. Get domain metrics
{"name":"site-explorer-metrics","arguments":{
  "target":"competitor.com",
  "date":"2026-03-11"
}}

# 2. See what they rank for
{"name":"site-explorer-organic-keywords","arguments":{
  "select":"keyword,position,volume,traffic,url",
  "target":"competitor.com",
  "date":"2026-03-11",
  "country":"us",
  "limit":20,
  "order_by":"traffic:desc"
}}

# 3. Find their competitors
{"name":"site-explorer-organic-competitors","arguments":{
  "select":"domain,common_keywords,keywords_unique_to_target",
  "target":"competitor.com",
  "country":"us",
  "date":"2026-03-11",
  "limit":10
}}
```

### Batch compare multiple domains

```bash
{"name":"batch-analysis","arguments":{
  "select":"target,domain_rating,organic_traffic,organic_keywords",
  "targets":["site1.com","site2.com","site3.com"],
  "country":"us"
}}
```

### Check API budget

```bash
{"name":"subscription-info-limits-and-usage","arguments":{}}
```

## Filter Syntax

The `where` parameter uses a JSON filter expression:

```json
{"field":"volume","is":["gte",100]}
```

Operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `substring`, `isubstring`, `prefix`, `suffix`, `regex`

Boolean combinators: `and`, `or`, `not`

```json
{"and":[
  {"field":"volume","is":["gte",100]},
  {"field":"difficulty","is":["lte",30]}
]}
```

## MCP Config (correct)

The `~/.pi/agent/mcp.json` entry should use the **remote URL**, not the npm package:

```json
{
  "ahrefs": {
    "url": "https://api.ahrefs.com/mcp/mcp",
    "headers": {
      "Authorization": "Bearer <from agent-secrets>"
    },
    "lifecycle": "lazy"
  }
}
```

**NOT** the npx command — that was the wrong setup. The npm `@ahrefs/mcp` package does NOT work with Standard plan auth. The remote endpoint does.

## Gotchas

1. **Empty results from `keywords-explorer-overview`**: This tool returns data only for keywords that exist exactly in Ahrefs' DB. Use `matching-terms` for discovery, `overview` for metrics on known keywords.
2. **CPC is in cents**: A CPC of `190` = $1.90
3. **`difficulty` costs extra units**: 10 units per row when included in `select`
4. **Date format**: Always `YYYY-MM-DD`
5. **Country codes**: Use ISO 2-letter codes (`us`, `gb`, `au`, etc.)
6. **The `doc` tool is your friend**: Always call it before using a new tool to get the real schema
7. **`http+sse is not supported`**: The server explicitly rejects SSE. Use POST-based Streamable HTTP only.
