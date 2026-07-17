---
name: add-skill
displayName: Add Skill
description: Create new joelclaw skills with the idiomatic process — repo-canonical, symlinked, git-tracked, slogged. Triggers on 'add a skill', 'create skill', 'new skill', 'canonical skill', 'make a skill for', or any request to formalize a process or domain into a reusable skill.
version: 0.1.0
author: joel
tags:
  - meta
  - skills
  - workflow
---

# Add Skill

Create a new joelclaw skill. Skills are modular instruction sets that extend agent capabilities with specialized knowledge, workflows, or tool integrations.

## Process

### 1. Create the skill directory

```bash
mkdir -p ~/Code/joelhooks/joelclaw/skills/<skill-name>
```

### 2. Write SKILL.md

Every skill needs a `SKILL.md` with frontmatter and instructions:

```markdown
---
name: <skill-name>
displayName: <Human Readable Name>
description: <One-line description. This shows in the skill list and is used for trigger matching.>
version: 0.1.0
author: joel
tags:
  - <relevant>
  - <tags>
---

# <Skill Title>

<Instructions for the agent. Write for another Claude instance — include non-obvious procedural knowledge, domain-specific details, gotchas, and reusable patterns.>

## When to Use

<Trigger phrases and situations that should activate this skill.>

## Operations

<Step-by-step procedures, commands, API calls, etc.>

## Rules

<Constraints, safety boundaries, things to never do.>
```

### 3. Add references (optional)

For complex skills, add supporting files:

```
skills/<skill-name>/
├── SKILL.md              # Required
├── references/           # Optional — detailed docs, examples
│   └── operations.md
├── scripts/              # Optional — helper scripts
└── assets/               # Optional — logos, templates
    ├── small-logo.svg    # For Codex desktop
    └── large-logo.png    # For Codex desktop
```

### 4. Symlink to all consumer directories

```bash
ln -sf ~/Code/joelhooks/joelclaw/skills/<skill-name> ~/.pi/agent/skills/<skill-name>
ln -sf ~/Code/joelhooks/joelclaw/skills/<skill-name> ~/.agents/skills/<skill-name>
ln -sf ~/Code/joelhooks/joelclaw/skills/<skill-name> ~/.claude/skills/<skill-name>
```

### 5. Record the receipt

The skill file and source-control diff are the primary receipt. Capture any durable workflow decision in the relevant Brain `.svx`; use canonical OTel only for runtime behavior. The former `slog` journal is retired.

### 6. Commit

The `skills/` directory is sacred and fully git-tracked. Every skill must be committed.

```bash
cd ~/Code/joelhooks/joelclaw
git add skills/<skill-name>
git commit -m "feat(skills): add <skill-name> — <short description>"
```

## Key Rules

- **Repo is canonical**: `~/Code/joelhooks/joelclaw/skills/` is the source of truth. Home dirs symlink to it.
- **Directory name must match `name` field** in SKILL.md frontmatter. Mismatch causes `[Skill conflicts]` warning on pi load.
- **Never copy skills** — always symlink. `cat > symlink` writes through and destroys the target.
- **External/third-party skill packs** stay external (global install), not copied into repo unless intentionally curated.
- **Pi extensions load at session startup only** — new skills are available immediately (loaded on demand), but if you modify an existing skill mid-session, run `/reload`.
- **One skill per concern** — don't overload a skill with unrelated capabilities. Split into focused skills.
- **Write for another agent** — the consumer is another Claude instance, not Joel. Include what's non-obvious.
- **Include trigger phrases** in the description — this is how pi matches user requests to skills.

## Installing External Skill Packs

External/third-party skills are installed globally, not copied into `joelclaw/skills/`, unless Joel explicitly wants to curate them into the repo.

For unattended installs, pass `-y` to both `npx` and the `skills` CLI:

```bash
npx -y skills add <owner>/<repo> --skill <skill-name> -g -y
```

Gotcha: `-g` installs globally but still opens the agent-selection prompt. The trailing `-y` accepts the default global agent set. Without it, headless sessions hang at the picker like a stunned mullet.

Verify the install:

```bash
ls -l ~/.agents/skills/<skill-name> ~/.pi/agent/skills/<skill-name>
```

## Updating Existing Skills

1. Edit the SKILL.md (or references) in the repo copy
2. Symlinks mean all consumers see the change immediately
3. Update the relevant Brain decision/receipt when the change alters durable workflow behavior
4. Commit

## Codex Desktop Metadata (optional)

For skills that should appear in Codex desktop:

```
skills/<skill-name>/
├── agents/
│   └── openai.yaml       # Codex agent config
└── assets/
    ├── small-logo.svg
    └── large-logo.png
```
