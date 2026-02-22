# Example: Published Video Note

This is a truncated example of a published note showing the target format and Joel's voice. The full version lives at `apps/web/content/openclaw-peter-steinberger-lex-fridman.mdx`.

## Frontmatter

```yaml
---
title: "OpenClaw: Peter Steinberger on Lex Fridman"
type: "note"
date: "2026-02-15"
description: "Notes on the Lex Fridman interview with Peter Steinberger — the guy who built OpenClaw in three months, hit 180k GitHub stars, and accidentally created the most chaotic open source saga of 2026."
source: "https://www.youtube.com/watch?v=YFjfBk8HI5o"
channel: "Lex Fridman"
duration: "03:15:52"
---
```

## Opening (hook + personal frame + embed)

```mdx
Three hours and fifteen minutes. I watched all of it. This is the interview that made me go _"I need to build my own version of this."_

[Peter Steinberger](https://steipete.com) built a one-hour prototype — hooking WhatsApp to Claude Code via CLI — and accidentally kicked off what might be the most important moment in AI since ChatGPT launched. [OpenClaw](https://github.com/nicepkg/openclaw) is an open-source AI agent that **lives on your computer, has access to all your shit, and actually does things**.

<YouTube id="YFjfBk8HI5o" />

## Why this matters to me

What makes this conversation worth your time isn't just the tech. It's Peter's whole arc...

**That's the part that got me.** Not the star count, not the tech stack — the fact that someone rediscovered the joy of building by playing with agents. I know that feeling. It's why JoelClaw exists.
```

## Key points section

Use `## The key stuff` or similar conversational header. Bullet list with bold lead-ins. Keep the substance from the vault note, tighten prose.

## Standalone sections for big stories

Pull out narratively rich sections (like the name change saga) into their own `##` headers instead of burying them in bullet points.

## Quotes section

```mdx
## Quotes that stuck with me

> I watched my agent happily click the I'm not a robot button.

> It's hard to compete against someone who's just there to have fun.
```

## Speaker context

```mdx
## Who is Peter Steinberger

[Peter Steinberger](https://steipete.com) ([@steipete](https://x.com/steipete)) is an Austrian software engineer...
```

## Ending (abrupt, warm)

```mdx
_This is the interview that started this whole project. If you've got three hours, watch it. If you don't, the key points above cover the stuff that matters most._
```
