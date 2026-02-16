# Quick Start Guide

Get context-efficient git/Graphite workflows running in 5 minutes.

## Prerequisites

- Git repository
- Claude Code 2.0+
- (Optional) Graphite CLI
- (Optional) jq for JSON processing

## Installation

### Option 1: Automated Installation (Recommended)

```bash
# Clone the repository
git clone https://github.com/your-username/carbon.git
cd carbon

# Run installer
./install.sh --project

# The installer will:
# - Copy files to .claude/plugins/
# - Configure SessionStart hook
# - Set up agent template
```

### Option 2: Manual Installation

```bash
# In your project
mkdir -p .claude/plugins/carbon/hooks
cd .claude/plugins/carbon

# Copy files
cp /path/to/plugin/hooks/session-start.sh hooks/
cp /path/to/plugin/settings.json .
cp /path/to/plugin/plugin.json .

# Make hook executable
chmod +x hooks/session-start.sh

# Copy agent template (optional)
mkdir -p .claude/agents
cp /path/to/plugin/./agents/graphite-ops-template.md .claude/agents/
```

## Verification

```bash
# Test hook execution
bash .claude/plugins/carbon/hooks/session-start.sh

# Should output JSON with hookSpecificOutput

# Test in Claude Code
claude --debug hooks

# Look for:
# [SessionStart] Executing hook: session-start.sh
# [SessionStart] Hook completed successfully
```

## First Use

```bash
# Start Claude Code
claude

# Try it out (hook automatically active)
> "Check my Graphite stack"

# Claude should automatically:
# 1. Recognize verbose operation
# 2. Delegate to Task subagent
# 3. Return concise summary

# Expected response:
# "✓ feature/auth | 3 PRs | Review #456"
# NOT: [15KB of JSON]
```

## Team Distribution

```bash
# Commit the configuration
git add .claude/
git commit -m "Add Graphite context-optimization plugin"
git push

# Team members pull and get automatic optimization
git pull
# Plugin activates automatically ✓
```

## Optional: Custom Agent Setup

For enhanced UX with colored terminal output:

```bash
# In Claude Code
claude

# Create agent
/agents create
  Name: graphite-ops
  Color: cyan
  Scope: project
  Prompt: Load from ./agents/graphite-ops-template.md

# Use it
> "graphite-ops check my stack"

# Output appears with cyan color:
graphite-ops [cyan]: ✓ feature/auth | 3 PRs | Review #456
```

## Troubleshooting

### Hook not firing

```bash
# Check permissions
chmod +x .claude/plugins/carbon/hooks/session-start.sh

# Check settings.json exists
ls -la .claude/settings.json

# Test manually
bash .claude/plugins/carbon/hooks/session-start.sh | jq .
```

### Context not appearing

```bash
# Verify hook returns correct JSON
bash .claude/plugins/carbon/hooks/session-start.sh | \
  jq '.hookSpecificOutput.hookEventName'

# Should output: "SessionStart"
```

### Patterns not applied

Start Claude with debug mode:

```bash
claude --debug hooks

# Check for:
# - Hook execution
# - Context injection
# - Any error messages
```

## Next Steps

- Read [User Guide](USER-GUIDE.md) for comprehensive usage
- Read [Custom Agents](CUSTOM-AGENTS.md) for agent setup
- See [examples/](../examples/) for configuration examples
- Check [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for common issues

## Quick Reference

### Common Operations

```bash
# Stack status
"Check my stack"
→ ✓ feature/auth | 3 PRs | Review #456

# PR list
"Show PRs needing review"
→ 📋 2 PRs: #456 (Auth), #457 (Docs)

# Git log
"Show me recent commits"
→ Last 10: abc123 Feature, def456 Fix, ...

# Submit
"Submit my stack"
→ ✓ 3 PRs created | CI running | Ready for review
```

### Using Custom Agent

```bash
"graphite-ops check my stack"
"graphite-ops show review queue"
"graphite-ops submit"
"graphite-ops navigate to next branch"
```

---

**That's it! You're ready to use context-efficient git/Graphite workflows.** 🚀

For more details, see the [complete User Guide](USER-GUIDE.md).
