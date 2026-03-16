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

# Runtime stage — bun
FROM oven/bun:1.3.9 AS runtime

WORKDIR /app

# Copy resolved workspace deps + only the packages needed at runtime
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=deps /app/packages/queue /app/packages/queue
COPY --from=deps /app/packages/restate /app/packages/restate
COPY --from=deps /app/packages/telemetry /app/packages/telemetry
COPY --from=deps /app/package.json /app/package.json

WORKDIR /app/packages/restate

ENV NODE_ENV=production

EXPOSE 9080

CMD ["bun", "run", "src/index.ts"]
