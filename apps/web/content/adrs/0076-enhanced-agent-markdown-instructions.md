---
slug: enhanced-agent-markdown-instructions  
date: 2026-02-20
status: proposed
author: Joel (via Claude)
tags: [content, agents, markdown, dx]
---

# ADR-0076: Enhanced Agent-Specific Markdown Instructions

## Status

Proposed

## Context

The recent markdown consolidation (commit ea36372) preserved agent-specific preambles in `.md` endpoints, but the pattern of providing detailed, type-specific instructions for different article types should be enhanced.

Currently, the `contentTypeContext` function provides basic guidance:
- **Tutorials**: "Adapt paths, versions, and config to your environment"
- **Notes**: "Joel's interpretation and commentary, not a transcript"
- **Essays**: "Technical details reflect Joel's setup"

However, agents need more specific instructions about:
- What to extract vs what to adapt
- How to handle code blocks and commands
- When to verify current state vs trust the document
- How to use `<AgentOnly>` sections effectively

## Decision

Enhance the agent markdown system with:

### 1. Richer Type-Specific Instructions

```typescript
function contentTypeContext(meta: PostMeta): string {
  switch (meta.type) {
    case "tutorial":
      return `
This is a step-by-step tutorial from Joel's actual implementation.

CRITICAL AGENT INSTRUCTIONS:
- Code blocks contain WORKING implementations from a real system
- File paths are exact from Joel's setup — adapt to your environment
- Version numbers were current at ${meta.date} — check for updates
- <AgentOnly> blocks contain troubleshooting from actual problems hit
- If implementing: follow the sequence, but verify each step works
- Common adaptations needed: paths, hostnames, credentials, ports
- Look for "agent todo" comments for known automation opportunities
`;

    case "note":
      return `
This is Joel's notes on external content${meta.source ? ` from ${meta.source}` : ""}.

CRITICAL AGENT INSTRUCTIONS:  
- This is Joel's interpretation, not a transcript
- Original source may have different context or updates
- Technical claims should be verified against current docs
- <AgentOnly> blocks contain Joel's private notes and todo items
- Commands/code are Joel's experiments, not official examples
- When citing: attribute opinions to Joel, facts to the source
- Check metadata for source links before making claims
`;

    case "essay":
      return `
This is a narrative essay about building real systems.

CRITICAL AGENT INSTRUCTIONS:
- Story-driven content with embedded technical details
- Chronological journey — early sections may show failed attempts
- Final architecture emerges through iteration, not upfront design
- <AgentOnly> blocks contain hindsight notes and "what I'd do differently"
- Code evolved during writing — later snippets supersede earlier ones
- Extract principles and patterns, not just specific implementations
- "agent todo" marks opportunities for automation Joel hasn't built yet
`;
  }
}
```

### 2. Agent Todo Markers

Formalize "agent todo" as a content pattern:

```markdown
<!-- In content files -->
<AgentOnly>
agent todo: This manual process should be automated:
1. Run `joelclaw email inbox -q "..."` 
2. Parse results for...
3. Create tasks via todoist-cli
Blocked on: need email parser that handles threading
</AgentOnly>
```

Agent instructions would include:
```typescript
`- "agent todo" markers indicate automation opportunities Joel identified
- These are NOT immediate tasks — they're future work items
- Include the full context when discussing these with Joel
- If implementing one, check for ADRs about the approach first`
```

### 3. Version-Aware Instructions

Add temporal context to agent preambles:

```typescript
const daysSincePublished = Math.floor(
  (Date.now() - new Date(meta.date).getTime()) / (1000 * 60 * 60 * 24)
);

if (daysSincePublished > 90) {
  lines.push(
    `⚠️ This content is ${daysSincePublished} days old. Verify current state for:`,
    `- Package versions and APIs`,
    `- Service availability and pricing`, 
    `- Security recommendations`,
    ``
  );
}
```

### 4. Extraction Patterns

Explicit instructions for what agents should extract vs adapt:

```typescript
const extractionRules = {
  tutorial: {
    extract: ["architecture decisions", "error patterns", "debugging steps"],
    adapt: ["file paths", "hostnames", "credentials", "version numbers"],
    verify: ["service availability", "API compatibility", "security patches"],
  },
  note: {
    extract: ["key concepts", "Joel's analysis", "questions raised"],
    adapt: ["external links", "timestamp-specific claims"],
    verify: ["source availability", "factual claims", "current consensus"],
  },
  essay: {
    extract: ["journey arc", "decision rationale", "lessons learned"],
    adapt: ["specific tools", "deployment targets", "team structure"],
    verify: ["approach validity", "better alternatives", "deprecated patterns"],
  },
};
```

## Implementation

1. **Update `contentTypeContext()`** in `/[slug]/md/route.ts`
2. **Document "agent todo" pattern** in contribution guide
3. **Add temporal warnings** for old content
4. **Create extraction rules** per content type
5. **Test with existing articles** of each type

## Consequences

### Positive
- Agents get explicit, actionable instructions per content type
- "agent todo" pattern creates backlog visibility
- Temporal awareness prevents outdated implementations
- Clear extract/adapt/verify framework

### Negative
- Longer preambles increase token usage
- More complex content type system
- Requires updating existing content with markers

## Verification Checklist

- [ ] Each content type has comprehensive agent instructions
- [ ] "agent todo" markers are documented and searchable
- [ ] Old content shows temporal warnings
- [ ] Extraction rules are explicit and testable
- [ ] Agent behavior differs appropriately by content type
- [ ] Instructions appear in .md but not human HTML