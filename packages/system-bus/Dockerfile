# system-bus-worker Docker image (k8s cluster role)
#
# Full workspace install, then copy entire node_modules tree to bun runtime.
# Reliable but larger image (~500MB). Optimizes for correctness over size.

FROM node:22-bookworm-slim AS deps
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

# Copy lockfile + workspace config for layer caching
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./

# Copy ALL package.json files for workspace resolution
COPY packages/ packages/
COPY apps/ apps/

# Install all deps (full workspace — ensures all cross-package deps resolve)
RUN pnpm install --frozen-lockfile --ignore-scripts

# Runtime stage — bun
FROM oven/bun:1.3.9

WORKDIR /app

# Copy everything from deps stage (source + resolved node_modules)
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=deps /app/packages/system-bus /app/packages/system-bus
COPY --from=deps /app/packages/email /app/packages/email
COPY --from=deps /app/packages/endpoint-resolver /app/packages/endpoint-resolver
COPY --from=deps /app/packages/inference-router /app/packages/inference-router
COPY --from=deps /app/packages/mdx-pipeline /app/packages/mdx-pipeline
COPY --from=deps /app/package.json /app/package.json

WORKDIR /app/packages/system-bus

ENV NODE_ENV=production
ENV INNGEST_DEV=0
ENV WORKER_ROLE=cluster

EXPOSE 3111

CMD ["bun", "run", "src/serve.ts"]
