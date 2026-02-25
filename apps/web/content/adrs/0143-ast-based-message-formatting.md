---
status: proposed
date: 2026-02-25
decision-makers: Joel
consulted: ADR-0069, ADR-0070, ADR-0086, ADR-0104, ADR-0131, vercel/chat (Chat SDK) format converter pattern
informed: joelclaw system owners
---

# ADR-0143: AST-Based Message Formatting via unified/remark

## History of Channel Message Formatting

The Telegram formatting pipeline has evolved through several iterations, each adding complexity to a fundamentally regex-based approach:

1. [`5af27e4`](https://github.com/joelhooks/joelclaw/commit/5af27e4) — Initial Telegram channel: grammY bot with basic md→HTML, chunking, outbound routing
2. [`fda48b6`](https://github.com/joelhooks/joelclaw/commit/fda48b6) (ADR-0069) — Improved Telegram formatting + smart notification filtering
3. [`4fb1959`](https://github.com/joelhooks/joelclaw/commit/4fb1959) (ADR-0070) — Inline keyboards + callback handler. `send()` gains `buttons`, `silent`, `noPreview` options
4. [`97df5c1`](https://github.com/joelhooks/joelclaw/commit/97df5c1) — Fix: escape HTML entities *before* markdown transforms (first escaping bug)
5. [`35aa12a`](https://github.com/joelhooks/joelclaw/commit/35aa12a) (ADR-0104) — Priority message queue, dedup, Telegram HTML validation. Added `isWellFormedTelegramHtml()` validator + `stripHtmlTags()` fallback
6. [`1150def`](https://github.com/joelhooks/joelclaw/commit/1150def) — Fix: protect existing HTML tags from double-escaping (second escaping bug, today). Added placeholder protection for valid Telegram tags before `escapeHtml()`

Each fix adds another layer of regex protection. The `mdToTelegramHtml()` function is now ~80 lines of interleaved placeholder extraction, escaping, regex transforms, and placeholder restoration. ADR-0131 (Unified Channel Intelligence Pipeline) will add Slack and Discord channels, each needing their own format rules.

**Related ADRs:**
- [ADR-0069](0069-*) — Telegram formatting + notification filtering
- [ADR-0070](0070-*) — Telegram Bot API upgrade (inline keyboards, rich send)
- [ADR-0086](0086-*) — Gateway phases 5-9 (outbound routing)
- [ADR-0104](0104-*) — Priority queue, dedup, HTML validation
- [ADR-0131](0131-unified-channel-intelligence-pipeline.md) — Unified channel pipeline (adds Slack, Discord)

**Reference implementation:** [vercel/chat](https://github.com/vercel/chat) (Chat SDK) — `packages/chat/src/markdown.ts` + per-adapter `FormatConverter` classes. Uses unified/remark for markdown→mdast parsing, each adapter walks the AST to emit platform-native format. Pattern borrowed, not the dependency.

## Context

The gateway currently uses fragile regex-based conversion in `mdToTelegramHtml()` (packages/gateway/src/channels/telegram.ts). This function:

1. Protects code blocks/links with placeholders
2. Runs `escapeHtml()` on everything (which escapes valid HTML tags from LLM responses)
3. Applies regex-based markdown→HTML transforms
4. Restores placeholders

This just broke — valid HTML tags from LLM responses got double-escaped (commit 1150def fix). The regex approach is inherently fragile: every new edge case requires another placeholder/regex rule.

As joelclaw expands to more channels (ADR-0131: Slack, Discord, iMessage), each will need its own formatting rules. Regex converters per platform don't scale.

## Decision

Adopt the AST-based format converter pattern (inspired by vercel/chat) using the unified/remark ecosystem. Own the code, not the dependency.

### Architecture

```
LLM response (markdown)
  → remark-parse → mdast AST (canonical representation)
    → TelegramConverter.fromAst() → Telegram HTML
    → SlackConverter.fromAst() → Slack mrkdwn
    → DiscordConverter.fromAst() → Discord markdown
    → PlainConverter.fromAst() → stripped text
    → iMessageConverter.fromAst() → plain text (no formatting)
```

### Core Interface

```typescript
import type { Root, Content } from "mdast";

interface FormatConverter {
  fromAst(ast: Root): string;
  toAst(platformText: string): Root;
  extractPlainText(platformText: string): string;
}

// Message type — converters consume this
type PostableMessage =
  | string                    // raw, no conversion
  | { markdown: string }      // parse → AST → platform format
  | { ast: Root }             // already parsed, just convert
  | { raw: string }           // raw, no conversion
```

### Dependencies (lightweight)

- `unified` — processor pipeline
- `remark-parse` — markdown → mdast
- `remark-gfm` — GFM support (tables, strikethrough)
- `remark-stringify` — mdast → markdown (for round-tripping)
- `mdast-util-to-string` — plain text extraction

These are small, well-maintained, already in the JS ecosystem. No framework dependency — just the parser and AST types.

### Platform Converters

Each converter walks the mdast tree and emits platform-native formatting:

**TelegramConverter** (replaces `mdToTelegramHtml`):
- `strong` → `<b>text</b>`
- `emphasis` → `<i>text</i>`
- `inlineCode` → `<code>text</code>`
- `code` → `<pre><code>text</code></pre>`
- `link` → `<a href="url">text</a>`
- `delete` → `<s>text</s>`
- `blockquote` → `<blockquote>text</blockquote>`
- `list` → `• item` (Telegram has no list tags)
- `heading` → `<b>text</b>` (Telegram has no heading tags)
- Text nodes: `escapeHtml()` only on text content, never on tags

**SlackConverter** (for ADR-0131):
- `strong` → `*text*`
- `emphasis` → `_text_`
- `delete` → `~text~`
- `link` → `<url|text>`
- `code` → `` `code` ``
- `blockquote` → `> text`

**DiscordConverter**:
- Standard markdown passthrough (Discord supports full markdown)
- Additions: spoiler tags, user/role mentions

**PlainConverter**:
- Strip all formatting, extract text only

### Key Design Principle

**Parse once, never double-escape.** The AST separates structure from text content. `escapeHtml()` runs only on `text` node values during Telegram rendering — formatting tags are emitted by the converter, never present in the input text.

This eliminates the entire class of "protect X before escaping, restore after" bugs.

### Package Location

`packages/gateway/src/formatting/` — not a separate package yet. Contains:
- `ast.ts` — parseMarkdown, stringifyMarkdown, type guards, node constructors
- `telegram.ts` — TelegramFormatConverter
- `slack.ts` — SlackFormatConverter (when ADR-0131 lands)
- `discord.ts` — DiscordFormatConverter (when needed)
- `plain.ts` — PlainFormatConverter
- `types.ts` — FormatConverter interface, PostableMessage type

### Migration

1. Add unified/remark deps to gateway package
2. Implement TelegramFormatConverter
3. Replace `mdToTelegramHtml()` calls with converter
4. Delete the regex-based converter
5. Add converters for other platforms as ADR-0131 progresses

## Consequences

### Easier
- No more double-escaping bugs — structural impossibility
- Each platform converter is testable in isolation with mdast fixtures
- Adding new platforms = one new converter class
- Round-trip capability: platform → AST → any other platform
- LLM responses can use standard markdown — no platform-specific prompting needed

### Harder
- unified/remark adds ~5 small dependencies
- Converter implementations need to handle every mdast node type
- AST walking is slightly more code than regex (but much more correct)
- Testing needs mdast fixtures per platform
## Codex Review (2026-02-25)

### Strengths
- `packages/gateway/src/channels/telegram.ts` already shows strong operational guardrails (`isWellFormedTelegramHtml`, `stripHtmlTags`, and fallback send paths), which aligns with ADR-0143’s goal of avoiding silent formatting failures.
- The ADR correctly identifies the core fragility in the current converter: escape/regex sequencing causes structural breakage; an AST path is the right long-term fix.
- The planned per-platform converter interfaces in `packages/gateway/src/formatting/` match ADR-0131’s trajectory and should reduce regex duplication for Slack/Discord/iMessage.
- The design principle of emitting tags from structure and escaping only text nodes directly addresses historical double-escape issues from `mdToTelegramHtml()`.

### Gaps
- Telegram limit handling is not fully robust: `CHUNK_MAX = 4000` leaves headroom but chunking is not aware of HTML structure, so tags or entities can be split and become invalid even when pre-chunk validation passes.
- `chunkMessage()` is purely length-based and doesn’t account for entity overhead, multiline UTF-8 boundaries, or tag boundaries, creating false negatives/positives near the 4096-char limit.
- `isWellFormedTelegramHtml()` checks the whole message before chunking; it does not ensure each chunk stays valid after splitting.
- `mdToTelegramHtml()` still depends on nested-regex transforms, so nested markdown or overlapping syntactic forms can mis-convert in ways an AST walk would avoid.
- In fallback logic, HTML failures switch to plaintext but still send a single truncated chunk (`slice(0, CHUNK_MAX)`) and stop, which can drop content in long messages.
- Placeholder protection in existing function relies on special sentinels and can be fragile under adversarial or unusual input despite current success cases.

### Risks
- AST migration without parser-aware chunking and validation can introduce a new class of runtime failures on long formatted messages: first-chunk failure then partial fallback behavior.
- Behavioral parity risk is high unless every existing regex edge case is fixture-tested; some weird but relied-on formatting inputs may regress.
- Dependency scoping risk: adding unified/remark packages only where needed (`packages/gateway`) is important, but adding them via loose ranges or conflicting versions can create bundle-size and startup overhead, especially in worker processes.
- Current ADR migration sequence is conceptual only; no explicit rollback criterion is specified even though Telegram send fallback behavior is already user-visible.

### Recommendations
- Make chunking parser-aware: split on safe boundaries (outside tags/entities), and validate each chunk before send; when invalid, either repair chunk boundaries or fall back deterministically.
- Fix fallback behavior to preserve full payload: if HTML parsing fails for a message, continue chunked plain sends of full stripped text rather than slicing one truncated chunk and breaking.
- Add a migration safety harness: dual-run conversion in staging (old regex and AST converter), with fixture coverage for nested emphasis/links/code/blockquote, HTML-in-markdown, emoji/UTF-8, and 4KB+ messages.
- Gate conversion mode via feature flag and emit telemetry (`converter_mode`, `invalid_html_rate`, `fallback_rate`, `truncated_chunks`) so rollback can be automatic and observable.
- Keep unified/remark dependency scope local to `packages/gateway` and document any parser contract (`allowed_nodes`) as part of the ADR so converter expectations are explicit before production rollout.
- Consider Telegram’s entity-based send API as a strategic alternative in a future phase if HTML parse_mode continues to be a recurring constraint under long-form/complex formatting.
