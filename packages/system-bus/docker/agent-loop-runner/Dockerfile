# Agent Loop Runner — isolated sandbox for PLANNER→IMPLEMENTOR→REVIEWER→JUDGE loop
# Contains: bun, git, codex CLI, claude CLI
# Usage: docker build -t agent-loop-runner .
# Run:   docker run --rm -e REPO_URL=... -e BRANCH=... -e GITHUB_TOKEN=... agent-loop-runner <cmd>

FROM debian:bookworm-slim AS base

# Avoid interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    git \
    unzip \
    jq \
    && rm -rf /var/lib/apt/lists/*

# ── Install Node.js (required by codex/claude CLIs) ──────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

# ── Install Bun ──────────────────────────────────────────────────────
RUN curl -fsSL https://bun.sh/install | bash
ENV BUN_INSTALL="/root/.bun"
ENV PATH="$BUN_INSTALL/bin:$PATH"

# ── Install Codex CLI ────────────────────────────────────────────────
# codex is an npm package: @openai/codex
RUN bun install -g @openai/codex

# ── Install Claude CLI ───────────────────────────────────────────────
# Claude Code is an npm package: @anthropic-ai/claude-code
RUN bun install -g @anthropic-ai/claude-code

# ── Verify tools ─────────────────────────────────────────────────────
RUN git --version && \
    bun --version && \
    which codex && \
    which claude

# ── Workspace setup ──────────────────────────────────────────────────
RUN mkdir -p /workspace
WORKDIR /workspace

# ── Entrypoint ───────────────────────────────────────────────────────
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
