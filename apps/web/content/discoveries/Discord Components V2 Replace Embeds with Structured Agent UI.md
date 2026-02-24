---
type: discovery
slug: discord-components-v2-replace-embeds-with-structured-agent-ui
source: "https://cybrancee.com/blog/the-future-of-discord-components-v2/"
discovered: "2026-02-24"
tags: [article, discord, agent-ui, typescript, channel-formatting, agent-loops]
relevance: "Direct input for ADR-0125 channel-aware formatting — Components V2 replaces embeds for structured agent responses in Discord channels"
---

# Discord Components V2 Replace Embeds with Structured Agent UI

Discord's [Components V2](https://cybrancee.com/blog/the-future-of-discord-components-v2/) is a structured layout system that makes embeds look like cave paintings. **Containers** with accent colors, **Sections** with accessories (buttons, thumbnails), **Separators**, **MediaGallery**, **TextDisplay** — it's a real component tree instead of the embed blob we've been stuck with.

The [discord.js](https://discord.js.org/) API surface is clean. `ContainerBuilder` and `SeparatorBuilder` follow the same builder pattern the library already uses. You flag a message with `MessageFlags.IsComponentsV2` and send components instead of embeds. The 40-component limit per message is the main constraint, but that's plenty for agent responses that need to show structured output — step results, status panels, action buttons — without jamming everything into a single embed field.

This matters for [ADR-0125](/adrs/adr-0125-channel-aware-formatting) channel-aware formatting. Right now agent responses going to Discord get flattened into markdown or crammed into embeds that weren't designed for structured data. Components V2 gives us **native layout primitives** — a Section can pair a text block with a thumbnail or button accessory, a Container groups related content with a colored accent bar, and Separators create visual hierarchy without hacking it with empty fields. The formatting layer can detect Discord as the target channel and emit component trees instead of markdown.

The 40-component ceiling means the formatter needs to be smart about chunking. A long agent loop status update might need to split across multiple messages or collapse detail sections. But that's a solved problem — the constraint is explicit and predictable, unlike embed limits that silently truncate.

## Key Ideas

- **Components V2** is Discord's structured layout system: [Containers](https://discord.com/developers/docs/components/reference#container), Sections, Separators, [MediaGallery](https://discord.com/developers/docs/components/reference#media-gallery), [TextDisplay](https://discord.com/developers/docs/components/reference#text-display)
- Flag messages with `MessageFlags.IsComponentsV2` to opt in — backward compatible, doesn't break existing embed messages
- [discord.js](https://discord.js.org/) provides `ContainerBuilder` and `SeparatorBuilder` following the existing builder pattern
- **40-component limit** per message — explicit ceiling, formatter needs chunking strategy
- Sections support **accessories** (buttons, thumbnails) paired with text — maps directly to agent response patterns (result + action)
- Accent colors on Containers give visual grouping without CSS — useful for status indication (green/red/yellow for pass/fail/pending)
- Strictly better than embeds for structured agent output — embeds were designed for link previews, not application UI

## Links

- [The Future of Discord Components V2 — Cybrancee](https://cybrancee.com/blog/the-future-of-discord-components-v2/)
- [Discord Components V2 Developer Docs](https://discord.com/developers/docs/components/overview)
- [discord.js Documentation](https://discord.js.org/)
- [discord.js GitHub](https://github.com/discordjs/discord.js)
- [ADR-0125 Channel-Aware Formatting](/adrs/adr-0125-channel-aware-formatting)
