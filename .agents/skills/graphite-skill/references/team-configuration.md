# Example: Team Configuration with Custom Agent

This example shows a complete team configuration with:
- SessionStart hook enabled
- Custom graphite-ops agent configured
- Team-shared via git

## Directory Structure

```
your-project/
├── .git/
└── .claude/
    ├── settings.json                    # Hook configuration
    ├── agents/
    │   └── graphite-ops.md              # Custom agent definition
    └── plugins/
        └── carbon/
            ├── hooks/
            │   └── session-start.sh     # Hook script
            ├── plugin.json
            └── settings.json
```

## settings.json

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/.claude/plugins/carbon/hooks/session-start.sh",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

## graphite-ops.md (Custom Agent)

```markdown
---
name: graphite-ops
description: Context-efficient Graphite and git operations
agent-color: cyan
tools:
  - bash_tool
  - view
  - str_replace
---

[... agent prompt from template ...]
```

## Usage

### For Team Lead (Setup)

```bash
# Install plugin
./install.sh --project

# Create custom agent
claude
/agents create
  Name: graphite-ops
  Color: cyan
  Prompt: Load from ./agents/graphite-ops-template.md

# Commit configuration
git add .claude/
git commit -m "Add Graphite context-optimization plugin"
git push
```

### For Team Members (Automatic)

```bash
# Pull repository
git pull

# Plugin activates automatically!
claude
> "Check my stack"
# Uses Task delegation automatically ✓

# Or use custom agent
> "graphite-ops check my stack"
# Gets cyan-colored output ✓
```

## Benefits for Teams

✅ **Zero per-developer setup** - Pull repo → get optimization  
✅ **Consistent behavior** - Everyone uses same patterns  
✅ **Visual organization** - Colored agents for easy recognition  
✅ **Git-tracked** - Configuration version-controlled  

## Customization

### Adjust Context Size

Edit `hooks/session-start.sh`:

```bash
# Reduce injected context from ~800 to ~400 tokens
CONTEXT="# Context-Optimization Active

For git/Graphite operations >100 tokens:
- Delegate to Task subagent
- Return: ✓ [state] | [count] | [action]"
```

### Project-Specific Patterns

Add custom patterns for your team:

```bash
CONTEXT+="

## Team-Specific Patterns
- Always run tests before submitting stack
- Check Jira ticket in commit messages
- Use branch naming: feature/PROJ-123-description"
```

### Multiple Agents

Create specialized agents for different workflows:

```bash
# Git operations
/agents create → git-ops [green]

# PR reviews  
/agents create → review-ops [blue]

# CI/CD
/agents create → deploy-ops [red]
```
