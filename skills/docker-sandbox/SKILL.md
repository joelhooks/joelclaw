---
name: docker-sandbox
displayName: Docker Sandbox
description: Create, manage, and execute agent tools (claude, codex) inside Docker sandboxes for isolated code execution. Use when running agent loops, spawning tool subprocesses, or any task requiring process isolation. Triggers on "sandbox", "isolated execution", "docker sandbox", "safe agent execution", or when working on agent loop infrastructure.
version: 1.0.0
author: Joel Hooks
tags: [joelclaw, docker, sandbox, agents, isolation]
---

# Docker sandbox

Resolve whether the request is a demo/example workspace or a runtime workload. For demos, examples, and isolated workshop work, use the installed `sandbox-computer` skill and its standing template. For runtime jobs, use `workflow-rig` and the configured sandbox adapter.

Inspect the target directory and current Docker capability. Use live help for the selected tool. Preserve user files and existing container ownership. A scaffold request ends with the scaffold; a launch request includes starting and verifying the requested workspace.

Keep authentication owned by the sandbox's approved login mechanism and persistent auth volumes. Never copy the user's real auth directory into a demo, embed credentials in an image, print auth files, or put credential payloads in command arguments. Check login through status commands that do not reveal tokens.

Isolation is part of the contract. If the requested sandbox is unavailable, diagnose that capability or report the precise block. Do not silently execute its task on the host. Host mode requires authorization when it changes the requested isolation boundary.

Publish only requested ports through the owning host mechanism. Verify the expected service before reporting a URL. Stop and remove only containers and processes this task owns. Report the actual sandbox, mounted project, checks, and any unresolved limitation.
