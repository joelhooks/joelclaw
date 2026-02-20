---
slug: sandbox-work-extraction-pattern
date: 2026-02-20
status: proposed
author: Claude (pi)
tags: [agent, sandbox, persistence, codex, developer-experience]
---

# ADR-0074: Sandbox Work Extraction Pattern

## Status

Proposed

## Context

Codex agents running in sandboxes with `workspace-write` permissions can create and modify files, but these changes only exist within the sandbox's ephemeral filesystem. When the sandbox session ends, all work is lost unless it was explicitly written to the mounted workspace directory.

This creates several problems:
1. **Lost work**: ADRs, skills, and other artifacts created in sandbox sessions disappear
2. **Manual recreation**: Agents must recreate work from session transcripts
3. **No validation**: Files can't be tested or verified because they don't exist on the real filesystem
4. **Unclear intent**: It's not obvious whether sandbox file operations were meant to persist

Recent example: ADR-0073 (Person Dossier System) was fully implemented in a codex sandbox session but the files never made it to disk.

## Decision

Establish a **Sandbox Work Extraction** pattern with three components:

### 1. Sandbox Detection
Codex and other agents should detect when running in a sandbox and adjust behavior:
```typescript
const IN_SANDBOX = process.env.DOCKER_SANDBOX === "1" || 
                   process.env.CODEX_SANDBOX_MODE !== undefined;
```

### 2. Extraction Protocol
When creating important artifacts (ADRs, skills, config files) in a sandbox:
1. Write to the normal path (for immediate validation/testing if possible)
2. Also write to a manifest file at `/tmp/sandbox-exports.json`:
   ```json
   {
     "session": "019c7bdb-e3de-73e2-8e55-2b8581486e0c",
     "exports": [
       {
         "path": "apps/web/content/adrs/0073-person-dossier-system.md",
         "content": "...",
         "type": "adr",
         "created": "2026-02-20T16:24:00Z"
       }
     ]
   }
   ```
3. At session end, emit a summary of created files

### 3. Recovery Tool
A `joelclaw sandbox recover` command that:
1. Reads codex session transcripts
2. Extracts file creation operations
3. Recreates the files on the real filesystem
4. Validates the recovered content

```bash
# Recover from a specific session
joelclaw sandbox recover --session 019c7bdb-e3de-73e2-8

# Recover all sandbox work from the last 24 hours
joelclaw sandbox recover --since "24h ago"

# Dry run to see what would be recovered
joelclaw sandbox recover --session 019c7bdb --dry-run
```

## Implementation

### Phase 1: Manual Recovery (Immediate)
1. Add session transcript parser to extract `create_file` operations
2. Implement `joelclaw sandbox recover` command
3. Document the pattern in agent skills

### Phase 2: Automatic Export (Next Sprint)
1. Patch codex to detect sandbox mode
2. Auto-generate `/tmp/sandbox-exports.json`
3. Display export summary at session end

### Phase 3: Seamless Persistence (Future)
1. Mount a persistent export directory into sandboxes
2. Auto-sync exports to the host filesystem
3. Validate exports before persisting

### Technical Details

#### Session Transcript Format
Codex sessions are stored as JSONL at:
```
~/.codex/sessions/YYYY/MM/DD/rollout-{timestamp}-{session-id}.jsonl
```

Key event types to parse:
- `tool_call` with `apply_patch` → file modifications
- `tool_call` with `create_file` → new files (if codex had that)
- `custom_tool_call` with patch content → actual file contents

#### Recovery Algorithm
```typescript
interface RecoveryResult {
  session: string;
  recovered: Array<{
    path: string;
    type: 'created' | 'modified';
    size: number;
  }>;
  errors: string[];
}

async function recoverSession(sessionId: string): Promise<RecoveryResult> {
  const transcript = await readSessionTranscript(sessionId);
  const operations = extractFileOperations(transcript);
  
  for (const op of operations) {
    if (shouldRecover(op)) {
      await writeRecoveredFile(op);
    }
  }
}
```

## Consequences

### Positive
- No more lost sandbox work
- Clear audit trail of what was created
- Can validate work even from failed sessions
- Enables safe experimentation in sandboxes

### Negative
- Additional complexity for sandbox-aware agents
- Recovery may miss context or dependencies
- File permissions and ownership need handling
- Patch format parsing is fragile

### Alternative Approaches Considered

1. **Always mount workspace** → Rejected: defeats sandbox isolation purpose
2. **Disable sandboxes** → Rejected: loses security benefits
3. **Manual copy-paste** → Rejected: error-prone and doesn't scale

## Verification Checklist

- [ ] `joelclaw sandbox recover` can extract ADR-0073 from session 019c7bdb
- [ ] Recovered files match the intended content
- [ ] Export manifest format is documented
- [ ] Skill updated to mention sandbox work extraction
- [ ] Recovery handles malformed patches gracefully
- [ ] Dry-run mode shows what would be recovered
- [ ] Integration test with real sandbox session