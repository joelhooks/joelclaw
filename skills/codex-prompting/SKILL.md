---
name: codex-prompting
displayName: Codex Prompting
description: "Use this skill for any request to trigger, coordinate, or craft prompts for Codex. Use when user says 'send to codex', 'use codex', 'prompt codex', 'ask codex', 'delegate to codex', 'run in codex', or asks for a Codex-first execution handoff."
version: 1.0.2
author: Joel Hooks
tags: [codex, prompting, automation, pi, operations]
disable-model-invocation: true
---

# Codex prompting

Turn the user's request into a bounded task and execute the requested handoff. State the outcome, repository and relevant paths, constraints, write authority, and evidence required for completion. Omit sections that do not help the task.

## Model and harness

Honor an explicitly requested model. Otherwise resolve the configured runtime role or inference catalog. Verify availability through the active harness; an old model name in a skill is not configuration. Record the actual model and settings for evaluations.

Use available tools by their real names. Read `codex exec --help` for CLI flags. Follow the active harness's sandbox, approval, progress-update, and instruction-priority rules. A rejected action is not permission to weaken those controls or retry an equivalent command.

## Execution

A clear action request authorizes the necessary work within its scope. Do not stop at a plan or ask again for permission already given. Ask only when a missing decision materially affects the outcome; continue independent work meanwhile.

Load relevant domain skills, not a generic checklist of every infrastructure skill. Keep user instructions above skill preferences. If a skill would block authorized work, name the exact file and rule and resolve the conflict by instruction priority.

For delegation, use the operator's configured orchestration workflow. Give each worker a bounded result and explicit write scope; preserve other sessions' edits. Use completion events or bounded waits, with useful work between checks.

## Verification and report

Run checks appropriate to the change. A typo edit needs diff inspection; a behavior change needs evidence for the affected behavior. Do not add repetitive tests or repeat a passing suite without new evidence.

Return the result, artifact or commit, checks and outcomes, and exact unresolved limitations. Do not claim execution, deployment, or delivery from a proposed command.

For prompt changes, consult current official model guidance and compare old/new behavior with harmless fixtures. A model explaining an instruction is a comprehension check, not proof of operational reliability.
