# restate-worker Docker image — full agent execution environment
#
# Contains: Restate worker services, Firecracker binary, pi agent CLI,
# codex CLI, full monorepo checkout with skills, and agent tooling.

FROM node:22-bookworm-slim AS deps
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

# Copy lockfile + workspace config for layer caching
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./

# Copy workspace sources for pnpm workspace resolution
COPY packages/ packages/
COPY apps/ apps/

# Install all deps (full workspace — ensures all cross-package deps resolve)
RUN pnpm install --frozen-lockfile --ignore-scripts

# Firecracker binary stage
FROM alpine:3.20 AS firecracker
ARG FC_VERSION=v1.15.0
ARG FC_ARCH=aarch64
RUN apk add --no-cache curl tar \
    && curl -sL "https://github.com/firecracker-microvm/firecracker/releases/download/${FC_VERSION}/firecracker-${FC_VERSION}-${FC_ARCH}.tgz" \
       -o /tmp/fc.tgz \
    && tar xzf /tmp/fc.tgz -C /tmp \
    && cp /tmp/release-${FC_VERSION}-${FC_ARCH}/firecracker-${FC_VERSION}-${FC_ARCH} /usr/local/bin/firecracker \
    && chmod +x /usr/local/bin/firecracker \
    && rm -rf /tmp/fc.tgz /tmp/release-*

# Runtime stage — bun + full agent environment
FROM oven/bun:1.3.9 AS runtime

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    openssh-client \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js (pi requires node in PATH)
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install pi CLI globally
RUN npm install -g @mariozechner/pi-coding-agent && pi --version

# Install codex CLI globally
RUN npm install -g @openai/codex || echo "codex install completed"

# Copy Firecracker binary
COPY --from=firecracker /usr/local/bin/firecracker /usr/local/bin/firecracker

WORKDIR /app

# Copy resolved workspace deps + ALL packages (full monorepo for agent code access)
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=deps /app/packages /app/packages
COPY --from=deps /app/apps /app/apps
COPY --from=deps /app/package.json /app/package.json

# Copy skills (canonical source, fully tracked in git)
COPY skills/ /app/skills/

# Copy agent identity chain
COPY .agents/ /app/.agents/

# Set up pi agent directory structure
RUN mkdir -p /root/.pi/agent/skills \
    && mkdir -p /root/.joelclaw \
    && mkdir -p /root/.joelclaw/workspace/memory \
    && mkdir -p /root/.joelclaw/workspace/inbox

# Symlink skills into pi's skill discovery path
RUN ln -sf /app/skills/* /root/.pi/agent/skills/ 2>/dev/null || true

# Symlink identity files into ~/.joelclaw/
RUN for f in /app/.agents/IDENTITY.md /app/.agents/SOUL.md /app/.agents/ROLE.md /app/.agents/USER.md /app/.agents/TOOLS.md; do \
      [ -f "$f" ] && ln -sf "$f" /root/.joelclaw/$(basename "$f"); \
    done 2>/dev/null || true

# Copy AGENTS.md as system prompt basis
COPY AGENTS.md /app/AGENTS.md

# Auth is mounted as a k8s secret volume at runtime — not baked into the image
# Mount point: /root/.pi/agent/auth.json

WORKDIR /app/packages/restate

ENV NODE_ENV=production
ENV PATH="/root/.bun/bin:/usr/local/bin:$PATH"

EXPOSE 9080

CMD ["bun", "run", "src/index.ts"]
