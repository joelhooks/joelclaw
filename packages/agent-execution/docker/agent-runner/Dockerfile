FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    jq \
    python3 \
    unzip \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash
ENV BUN_INSTALL="/root/.bun"
ENV PATH="$BUN_INSTALL/bin:$PATH"

RUN bun install -g @openai/codex @anthropic-ai/claude-code

RUN mkdir -p /app/packages/agent-execution/src /workspace
WORKDIR /workspace

COPY packages/agent-execution/src /app/packages/agent-execution/src

CMD ["bun", "run", "/app/packages/agent-execution/src/job-runner.ts"]
