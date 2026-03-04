FROM inngest/inngest

# ADR-0194: sqlite3 CLI required for stale-run forensics and sweep operations.
# The base image ships libsqlite3-0 but not the CLI tool.
RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends sqlite3 && \
    rm -rf /var/lib/apt/lists/*
