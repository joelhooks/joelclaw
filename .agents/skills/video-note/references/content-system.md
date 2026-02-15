# joelclaw.com Content System

## Content types

Frontmatter `type` field distinguishes content:

| Type | Badge | Use |
|---|---|---|
| `article` (default) | none | Original writing, deep dives |
| `note` | `note` badge | Video notes, book notes, observations |

## File location

All content: `apps/web/content/*.mdx`

## Routing

Flat at `/{slug}` — notes and articles share the same URL space.

## MDX components

Available in content files:

```jsx
<YouTube id="dQw4w9WgXcQ" />  // responsive 16:9 iframe embed
```

## Frontmatter schema

### Article (existing)

```yaml
title: string       # required
date: string        # required, YYYY-MM-DD
description: string # required
```

### Note (video)

```yaml
title: string       # required
type: "note"        # required — triggers badge
date: string        # required, YYYY-MM-DD
description: string # required
source: string      # YouTube URL
channel: string     # channel name (shown in header)
duration: string    # HH:MM:SS (shown in header)
```

## Source vault location

Video notes live at: `/Users/joel/Vault/Resources/videos/`

List available notes:
```bash
ls /Users/joel/Vault/Resources/videos/*.md
```
