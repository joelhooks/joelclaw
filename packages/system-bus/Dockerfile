# system-bus-worker Docker image (k8s cluster role)
#
# Uses pnpm fetch → pnpm install --offline for fast, reproducible builds.
# No build step — bun runs from source.

FROM node:22-bookworm-slim AS deps
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

# Stage 1: fetch all packages into virtual store (only needs lockfile)
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

# Stage 2: copy manifests + source, install offline
COPY . .
RUN pnpm install --offline --frozen-lockfile

# Runtime stage — bun
FROM oven/bun:1.3.9

WORKDIR /app

# Only copy what system-bus needs:
#  - packages/system-bus/ (source + node_modules)
#  - workspace root node_modules (hoisted deps)
#  - workspace package sources that system-bus imports
COPY --from=deps /app/packages/system-bus /app/packages/system-bus
COPY --from=deps /app/packages/email /app/packages/email
COPY --from=deps /app/packages/endpoint-resolver /app/packages/endpoint-resolver
COPY --from=deps /app/packages/inference-router /app/packages/inference-router
COPY --from=deps /app/packages/mdx-pipeline /app/packages/mdx-pipeline
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=deps /app/package.json /app/package.json

WORKDIR /app/packages/system-bus

ENV NODE_ENV=production
ENV INNGEST_DEV=0
ENV WORKER_ROLE=cluster

EXPOSE 3111

CMD ["bun", "run", "src/serve.ts"]
