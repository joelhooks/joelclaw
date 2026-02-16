---
type: discovery
slug: executable-docs-agent-proof-of-work
source: "https://github.com/simonw/showboat"
discovered: "2026-02-16"
tags: [repo, cli, go, ai, agent-loops, proof-of-work, verification]
relevance: "verify command is a mechanical reviewer — re-runs all blocks and diffs output, same pattern as agent loop judge step"
---

# Executable Documents as Agent Proof-of-Work

Simon Willison's [Showboat](https://github.com/simonw/showboat) flips the script on agent output. Instead of asking an agent to produce code and then separately verifying it worked, the **document itself is the proof**. A markdown file accumulates executable code blocks and their captured output as the agent works. Then `showboat verify` re-runs every block and diffs against the recorded output. If anything changed, it fails. The artifact and the test are the same thing.

The CLI is deliberately agent-shaped — `init`, `note`, `exec`, `pop`, `verify`, `extract`. An agent builds the document incrementally with `exec` (which prints stdout so it can react to errors), backs out mistakes with `pop`, and the whole thing is reproducible from scratch via `extract`. Written in Go, distributed via PyPI, which is a fun deployment choice. The `exec` command returns the child process exit code so agents can branch on failure without parsing output.

The **verify-as-diff** pattern is the real insight here. It's not just "run the tests." It's "re-run the exact sequence of commands that built this artifact and confirm the world hasn't changed." That's a stronger guarantee than a test suite because it captures the full build narrative, not just assertions about the end state. The `--output` flag on verify writes an updated copy without modifying the original — non-destructive verification with a paper trail.

This maps cleanly onto the agent loop architecture. The reviewer step already asks "does this work?" — but Showboat gives you a **mechanical answer** instead of an LLM judgment call. An agent that builds a Showboat document as it implements a story produces its own verifiable receipt. The judge step could just run `showboat verify` and get a binary pass/fail with diffs.

## Key Ideas

- **Document-as-test**: the artifact and its verification are the same file — no separate test suite to maintain
- **Incremental building with `pop`**: agents can back out failed commands without corrupting the document, which is undo for append-only logs
- **`verify` as mechanical reviewer**: re-execute all blocks, diff output, exit 0 or 1 — no LLM needed for the "did it work?" question
- **`extract` for reproducibility**: emit the exact CLI commands to rebuild a document from scratch, which means documents are both human-readable and machine-replayable
- **Agent-first CLI design**: stdout passthrough on `exec`, exit code forwarding, stdin piping — every command is designed for non-human callers
- **Proof-of-work pattern**: the verified document proves the agent actually ran the commands and got the outputs, not that it hallucinated a plausible-looking transcript

## Links

- [Showboat on GitHub](https://github.com/simonw/showboat)
- [Example demo document](https://github.com/simonw/showboat-demos/blob/main/shot-scraper/README.md) (built by Claude Code)
- [Claude Code transcript](https://gisthost.github.io/?29b0d0ebef50c57e7985a6004aad01c4/page-001.html#msg-2026-02-06T07-33-41-296Z) showing the agent building the demo
- [Simon Willison's blog](https://simonwillison.net/) — by [[Simon Willison]]
