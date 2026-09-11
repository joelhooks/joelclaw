---
name: skill-review
displayName: Skill Review & Garden
description: "Audit and maintain the joelclaw skill inventory. Use when checking skill health, fixing broken symlinks, finding stale skills, or running the skill garden. Triggers: 'skill audit', 'check skills', 'stale skills', 'skill health', 'skill garden', 'broken skill', 'skill review', 'fix skills', 'garden skills', or any task involving skill inventory maintenance."
version: 1.1.0
author: Joel Hooks
tags: [joelclaw, skills, maintenance, gardening, automation]
disable-model-invocation: true
---

# Skill review

Audit the installed inventory against canonical sources and live evidence. Resolve symlinks before editing; installed roots may expose several repositories and namespaced packs. Inspect repository status and preserve existing edits.

## Inventory

List skill roots and canonical targets. Record duplicate names, broken links, missing frontmatter, trigger overlap, and large entry files. Distinguish managed sources from vendor or plugin caches. Do not treat a directory as an orphan merely because one consumer root lacks a direct link.

Read the candidate before changing it. Check commands against live help or source, runtime facts against current configuration, and behavioral rules against the user request and harness hierarchy. An old AGENTS.md is evidence to review, not proof of live topology.

## Prune and repair

Keep name, provenance, invocation metadata, operational constraints, and domain-specific gotchas. Remove repeated trigger lists, stale model pins, copied command manuals, duplicated global policy, and approval gates that disregard authorization already given.

Disclose branch-specific reference material behind an explicit trigger. Preserve its links. Do not replace useful runbooks with empty pointers or update vendor caches as if they were canonical.

Use `joelclaw skills ensure --help` for supported install repairs. Inspect real-directory conflicts before replacing anything. Add or change install manifests in their owning repository.

## Verify

Check metadata, link targets, affected commands, and prompt installation where relevant. Use realistic before/after model cases for substantial behavior changes. Include an already-authorized action, missing input, a near-miss trigger, and a boundary that must hold. Separate static findings from observed execution.

Report every scanned source's disposition: changed, reviewed without change, or needs deeper review. Save unresolved findings with paths and reasons. A broad pattern scan is not a full semantic review.

The optional garden implementation is `packages/system-bus/src/inngest/functions/skill-garden.ts`. Inspect its current events, patterns, and schedule before invoking it; a manual audit does not require starting a background workflow.
