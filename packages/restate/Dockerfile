# restate-worker Docker image (k8s worker role)
#
# Full workspace install, then copy the workspace node_modules tree plus the
# minimal package set this worker needs into the bun runtime image.

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

# Runtime stage — bun
FROM oven/bun:1.3.9 AS runtime

# Install curl for Firecracker API socket calls
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

# Copy Firecracker binary
COPY --from=firecracker /usr/local/bin/firecracker /usr/local/bin/firecracker

WORKDIR /app

# Copy resolved workspace deps + only the packages needed at runtime
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=deps /app/packages/agent-execution /app/packages/agent-execution
COPY --from=deps /app/packages/queue /app/packages/queue
COPY --from=deps /app/packages/restate /app/packages/restate
COPY --from=deps /app/packages/telemetry /app/packages/telemetry
COPY --from=deps /app/package.json /app/package.json

WORKDIR /app/packages/restate

ENV NODE_ENV=production

EXPOSE 9080

CMD ["bun", "run", "src/index.ts"]
