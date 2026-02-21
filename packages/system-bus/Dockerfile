FROM oven/bun:1.2.21

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
  python3 \
  make \
  g++ \
  && rm -rf /var/lib/apt/lists/*

# Monorepo install so workspace deps resolve for @joelclaw/system-bus.
COPY . .
RUN bun install

WORKDIR /app/packages/system-bus

ENV NODE_ENV=production
ENV INNGEST_DEV=0
ENV WORKER_ROLE=cluster

EXPOSE 3111

CMD ["bun", "run", "src/serve.ts"]
