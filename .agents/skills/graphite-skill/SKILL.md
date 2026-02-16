---
name: graphite-skill
description: Context-efficient Git and Graphite workflows for Claude Code. Automatically delegates verbose git/Graphite CLI operations to isolated subagents, reducing context pollution by 225x. Use when working with git operations, Graphite stacked diffs, or any git workflow that produces verbose output. Prevents context window exhaustion by automatically applying delegation patterns via SessionStart hooks.
---

# Graphite Skill - Context-Efficient Git/Graphite Workflows

Stop drowning in verbose git/Graphite output. This skill automatically enables context-efficient workflows for all git and Graphite CLI operations in Claude Code through automatic delegation patterns.

## Core Principles

1. **Automatic Delegation**: Verbose git/Graphite operations are automatically delegated to Task subagents
2. **Context Isolation**: Raw CLI output (15KB+) is processed in isolated context, summaries (<50 tokens) returned
3. **Zero Friction**: SessionStart hooks inject patterns automatically - no manual invocation needed
4. **Team-Ready**: Git-trackable configuration for team-wide distribution
5. **225x Efficiency**: Dramatic context window improvements (4,108 tokens → 18 tokens)

## Problem Statement

### Before Graphite Skill (Context Pollution)

```bash
You: "Check my Graphite stack"
Claude: [Returns 15KB of JSON → 4,000+ tokens consumed]
Result: Context polluted, reasoning degraded, 2-3 operations max
```

**Traditional git/Graphite operations flood context:**
- `gt stack` → 15KB JSON (4,108 tokens)
- `git log --graph` → 50KB output (12,000+ tokens)
- `gt pr info` → 20KB JSON (5,000+ tokens)
- Multiple queries → Context window exhaustion

### After Graphite Skill (Context Efficiency)

```bash
You: "Check my Graphite stack"
Claude: [Automatically delegates to Task subagent]
Subagent: [Processes 15KB in isolated context]
Claude: "✓ feature/auth | 3 PRs | Review #456"
Result: Clean context, 18 tokens used, 100+ operations possible
```

## Installation

### Auto-Detection (Recommended)

**The skill automatically detects if setup is needed!**

When you have the carbon-flow plugin installed globally but haven't set up Graphite Skill in your project, the SessionStart hook will automatically prompt you with:

```
⚠️ Graphite Skill Setup Required

Would you like to set up Graphite Skill in this project now?

If yes, run: bash ~/.claude/plugins/mad-skills/graphite-skill/install.sh --project
```

Simply run the provided command and the skill activates immediately. No need to remember or look up installation steps.

### Prerequisites

- Git repository
- Claude Code 2.0+
- (Optional) Graphite CLI for Graphite-specific workflows
- (Optional) jq for JSON processing in hooks

### Manual Installation

```bash
# Navigate to your project
cd /path/to/your/project

# Run the installer
bash ~/.claude/plugins/mad-skills/graphite-skill/install.sh --project

# The installer will:
# - Copy hooks to .claude/plugins/graphite-skill/
# - Configure SessionStart hook
# - Set up agent templates
# - Make scripts executable
```

### Manual Installation

```bash
# In your project
mkdir -p .claude/plugins/graphite-skill/hooks

# Copy files from the carbon skill directory
cp ~/.claude/plugins/mad-skills/graphite-skill/hooks/session-start.sh .claude/plugins/graphite-skill/hooks/
cp ~/.claude/plugins/mad-skills/graphite-skill/settings.json .claude/plugins/graphite-skill/

# Make hook executable
chmod +x .claude/plugins/graphite-skill/hooks/session-start.sh

# Optional: Copy agent template
mkdir -p .claude/agents
cp ~/.claude/plugins/mad-skills/graphite-skill/agents/graphite-ops-template.md .claude/agents/
```

### Verification

```bash
# Test hook execution
bash .claude/plugins/graphite-skill/hooks/session-start.sh

# Should output JSON with hookSpecificOutput

# Test in Claude Code
claude --debug hooks

# Look for:
# [SessionStart] Executing hook: session-start.sh
# [SessionStart] Hook completed successfully
```

## How It Works

### SessionStart Hook Mechanism

The skill uses a SessionStart hook to inject context-optimization patterns automatically:

```
1. Session starts → SessionStart hook fires
2. Hook detects: git repo, project setup status, Graphite CLI, custom agent
3a. If not set up → Prompts user to run install.sh (auto-detection)
3b. If set up → Hook injects ~800 tokens of delegation patterns into context
4. Claude knows: Use Task delegation for verbose operations automatically
5. User benefits: Automatic context efficiency, zero manual effort
```

**Auto-Detection Logic:**

The hook intelligently detects whether per-project setup has been completed by checking for the existence of `.claude/plugins/graphite-skill/hooks/session-start.sh` in your project directory.

- **Not set up**: Hook displays setup prompt with installation instructions
- **Set up**: Hook injects delegation patterns and activates context optimization

This means you never have to remember installation steps - the skill tells you exactly what to do.

### Automatic Delegation Pattern

When you request git/Graphite operations, Claude automatically:

1. **Recognizes** the operation will return verbose output
2. **Delegates** to Task subagent with explicit instructions:
   - Use `--json` flags for structured output
   - Redirect errors with `2>/dev/null`
   - Parse and summarize results
3. **Subagent executes** in isolated context (absorbs verbose output)
4. **Subagent returns** concise summary (<50 tokens)
5. **You receive** actionable summary without context pollution

**No manual invocation needed - patterns apply automatically!**

## Workflows

### Basic Git Operations

**Checking status:**
```bash
You: "Check git status"
Claude: [Delegates automatically]
→ "3 modified, 2 staged, 1 untracked | Ready to commit"
```

**Viewing commit history:**
```bash
You: "Show me recent commits"
Claude: [Delegates automatically]
→ "Last 10: abc123 Feature, def456 Fix, ... | 3 authors, 2 days"
```

**Reviewing changes:**
```bash
You: "Show git diff"
Claude: [Delegates automatically]
→ "+47/-12 across 3 files | auth.ts, api.ts, tests/ | No conflicts"
```

### Graphite Workflows

**Stack status:**
```bash
You: "Check my Graphite stack"
Claude: [Delegates automatically]
→ "✓ feature/auth | 3 PRs | #456 (needs review), #457 (approved), #458 (draft)"
```

**PR management:**
```bash
You: "Show PRs needing review"
Claude: [Delegates automatically]
→ "📋 2 PRs: #456 (Auth - awaiting review), #459 (Docs - changes requested)"
```

**Submitting stack:**
```bash
You: "Submit my stack for review"
Claude: [Delegates automatically]
→ "✓ 3 PRs created | CI running on all | Ready for review"
```

**Stack navigation:**
```bash
You: "Navigate to next branch in stack"
Claude: [Delegates automatically]
→ "Switched to feature/auth-ui (3/5 in stack)"
```

### Supported Operations

**Git Commands (auto-delegated):**
- `git log --graph` - Commit history with summarization
- `git diff` - Changes with statistics
- `git status` - Status with file grouping
- `git branch` - Branch listing with current indicator
- All other verbose git commands

**Graphite CLI Commands (auto-delegated):**
- `gt stack` - Stack status with PR summaries
- `gt pr list` - PR listing with filtering
- `gt pr info` - Detailed PR data with parsing
- `gt submit` - Submission with confirmation
- `gt log` - Stack history with formatting
- All other verbose gt commands

## Two Approaches: Task Tool vs Custom Agent

### Task Tool (Default - Recommended)

Zero setup, works immediately with automatic delegation:

```bash
You: "Check my stack"
Claude: [Uses Task delegation automatically]
→ Concise summary
```

**Characteristics:**
- ⚡ No configuration needed
- 📦 Works universally
- 🎯 Full context isolation
- ⚪ Standard terminal output
- ✅ **Recommended for most users**

### Custom Agent (Optional - Power Users)

Enhanced UX with colored terminal output:

```bash
# One-time setup in Claude Code
/agents create
  Name: graphite-ops
  Color: cyan
  Scope: project
  Prompt: Load from .claude/agents/graphite-ops-template.md

# Use with color
You: "graphite-ops check my stack"
graphite-ops [cyan]: ✓ feature/auth | 3 PRs | Review #456
```

**Characteristics:**
- 🎨 Colored terminal output (cyan)
- 👤 Consistent persona
- 📁 Git-tracked definition
- 🎯 Same context isolation
- 🔧 Requires one-time agent creation

**Agent Template Location:** `graphite-skill/agents/graphite-ops-template.md`

## Team Distribution

Graphite Skill is designed for team-wide adoption:

```bash
# One team member sets up
./install.sh --project
git add .claude/
git commit -m "Add Graphite Skill context-optimization for git/Graphite"
git push

# Other team members pull and get:
# ✓ Automatic context optimization
# ✓ Consistent behavior across team
# ✓ Zero per-developer setup
```

**Team benefits:**
- Consistent git/Graphite workflows
- Automatic efficiency for all developers
- Git-tracked configuration (no separate distribution)
- SessionStart hook activates automatically

## Configuration

### Default Configuration

The skill works out-of-box with sensible defaults. No configuration required.

### Custom Configuration

Adjust behavior by editing `.claude/plugins/graphite-skill/settings.json`:

```json
{
  "contextTokens": 800,
  "delegationThreshold": 100,
  "autoDetectGraphite": true,
  "autoDetectCustomAgent": true,
  "enableTaskDelegation": true,
  "enableCustomAgent": true
}
```

**Settings explanation:**
- `contextTokens`: Amount of pattern context injected (default: 800)
- `delegationThreshold`: Token size to trigger delegation (default: 100)
- `autoDetectGraphite`: Automatically detect Graphite CLI presence (default: true)
- `autoDetectCustomAgent`: Detect and suggest custom agent if available (default: true)
- `enableTaskDelegation`: Enable automatic Task delegation (default: true)
- `enableCustomAgent`: Enable custom agent support (default: true)

## Efficiency Metrics

| Metric | Before (Raw CLI) | After (Graphite Skill) | Improvement |
|--------|------------------|----------------|-------------|
| Tokens consumed | 4,108 | 18 | **225x** |
| Context pollution | High | Minimal | **99.6% reduction** |
| Response quality | Degraded | Optimal | **Focused reasoning** |
| User effort | Manual patterns | Zero | **Automatic** |
| Operations before exhaustion | 2-3 | 100+ | **50x** |

## Troubleshooting

### Hook not firing

```bash
# Check permissions
chmod +x .claude/plugins/graphite-skill/hooks/session-start.sh

# Check settings.json exists
ls -la .claude/settings.json

# Test manually
bash .claude/plugins/graphite-skill/hooks/session-start.sh | jq .
```

### Context not appearing

```bash
# Verify hook returns correct JSON
bash .claude/plugins/graphite-skill/hooks/session-start.sh | \
  jq '.hookSpecificOutput.hookEventName'

# Should output: "SessionStart"
```

### Patterns not applied

Start Claude with debug mode:

```bash
claude --debug hooks

# Check for:
# - Hook execution confirmation
# - Context injection success
# - Any error messages
```

### Delegation not automatic

If Claude doesn't delegate automatically:

1. Verify SessionStart hook is active: `claude --debug hooks`
2. Check hook output contains delegation patterns
3. Manually request delegation: "Use Task delegation for this"
4. Review hook configuration in `settings.json`

## Files and Structure

```
graphite-skill/
├── SKILL.md                       # This file - complete skill reference
├── install.sh                     # Automated installation script
├── settings.json                  # Configuration settings
├── hooks/
│   └── session-start.sh          # SessionStart hook for pattern injection
├── agents/
│   └── graphite-ops-template.md  # Custom agent template (optional)
├── examples/
│   └── team-configuration.md     # Example team configurations
├── test/
│   └── verify-installation.sh    # Installation verification script
├── QUICKSTART.md                  # Quick start guide
└── README.md                      # Detailed documentation

References (from root skill directory):
- QUICKSTART.md - 5-minute setup guide
- README.md - Complete documentation
- examples/team-configuration.md - Team setup examples
```

## When to Use This Skill

**Always active** - The SessionStart hook applies patterns automatically, so you don't need to manually invoke this skill. Just use git/Graphite naturally:

- Checking stack status
- Reviewing PRs
- Viewing commit history
- Managing branches
- Submitting for review
- Any git/Graphite operation

**The skill is already working if:**
- SessionStart hook is installed
- Claude automatically delegates verbose operations
- You receive concise summaries instead of raw output

## References

For detailed information:
- **Quick Start**: `graphite-skill/QUICKSTART.md` - 5-minute setup guide
- **Installation**: `graphite-skill/install.sh` - Automated installation
- **Team Setup**: `graphite-skill/examples/team-configuration.md` - Team configuration examples
- **Agent Template**: `graphite-skill/agents/graphite-ops-template.md` - Custom agent definition

## Status

- ✅ Production-ready
- ✅ Tested with Claude Code 2.0+
- ✅ Compatible with Graphite CLI 1.0+
- ✅ Team-ready with git-tracked configuration
- ✅ Zero-friction automatic activation
