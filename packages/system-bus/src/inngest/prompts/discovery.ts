/**
 * Discovery note prompt — the "skill" for the discovery-capture Inngest function.
 *
 * This is what pi gets when it's asked to write a discovery vault note.
 * It needs to: investigate, title, tag, write in Joel's voice.
 */

export const DISCOVERY_PROMPT = (opts: {
  url: string | undefined;
  context: string | undefined;
  sourceType: string;
  sourceContent: string;
  today: string;
  vaultDir: string;
}) => `Read the joel-writing-style skill at ~/.pi/agent/skills/joel-writing-style/SKILL.md first.

You are writing a discovery note for Joel's Obsidian Vault. This is a note about something Joel found interesting — a repo, tool, article, idea, or pattern worth remembering.

## Source

- URL: ${opts.url ?? "none (conversation)"}
- Joel said: ${opts.context ?? "(just flagged it as interesting)"}
- Source type: ${opts.sourceType}
- Date: ${opts.today}

## Source Material

${opts.sourceContent}

## Your Job

### 1. Title

The title is the most important part. It should be **a compelling, specific insight** — not a description, not a slug, not a tagline.

Good titles capture WHY something is interesting, not just WHAT it is:
- ✅ "Executable Documents as Agent Proof-of-Work"
- ✅ "Multi-Model Fan-Out for Cross-Checking LLM Output"  
- ✅ "Browser Cookies as API Key Alternative"
- ✅ "Self-Describing Markdown That Rebuilds Itself"

Bad titles are just names or descriptions:
- ❌ "showboat — executable demo documents for agents"
- ❌ "Oracle Webpage Monitor"
- ❌ "Interesting CLI Tool"
- ❌ "Simon Willison's New Project"

The title should make someone want to open the note six months from now. It's the hook.

### 2. Filename

Use the title as the filename — readable, not a slug. Obsidian uses the filename as the note name in the sidebar, wikilinks, and graph view.
Example: "Executable Documents as Agent Proof-of-Work.md" NOT "executable-docs-agent-proof-of-work.md"

### 3. Tags

Decide tags based on what you find. Include:
- Source type: repo, article, tool, idea, paper, pattern
- Domain: ai, cli, infrastructure, typescript, go, etc.
- Relevant system concepts: agent-loops, event-bus, vault, memory, video-pipeline, etc.

### 4. Relevance

One line connecting this to Joel's system. Be specific:
- ✅ "verify command pattern maps to agent loop reviewer step"
- ❌ "could be useful for the system"

### 5. Body

2-4 paragraphs in Joel's voice:
- Direct, no throat-clearing, no "In this note I'll discuss..."
- Say what it IS, why it's CLEVER, and whether it's USEFUL
- Connect to Joel's system where natural — don't force it
- Bold for emphasis, short paragraphs
- Do NOT fabricate Joel's opinions — describe and analyze

### 6. Key Ideas

Bullet the notable concepts. Each bullet should be self-contained.

### 7. Links

Source URL + any related references you discover.

## Output

Write the file to ${opts.vaultDir}/{Title}.md (use the exact title as the filename) using this format:

---
type: discovery
source: "${opts.url ?? "conversation"}"
discovered: "${opts.today}"
tags: [your-chosen-tags]
relevance: "your specific one-liner"
---

# {Your compelling title}

{Body paragraphs}

## Key Ideas

- {bullets}

## Links

- {links}

After writing the file, print ONLY: DISCOVERY_WRITTEN:{exact filename without .md extension}
Do NOT print anything else after that line.

IMPORTANT: Write the file with the write tool. Do not ask questions. Just do it.`;
