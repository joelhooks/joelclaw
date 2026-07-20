# Critical-search replica

This is one read-only shim deployed twice. Each NAS stores `critical.db` on its own local disk. The container mounts only that local directory and never uses NFS or SMB.

## Safety boundary

- The container runs as the NAS owner UID/GID, drops all capabilities, uses a read-only root filesystem, and mounts `./data` read-only.
- Only `flagg` writes the source database.
- `scripts/replicate-critical-db.sh` copies an immutable SQLite snapshot to `critical.db.incoming`, verifies SHA-256, then renames it atomically.
- Every health and search request needs a generated 256-bit bearer token. Bind to the verified tailnet interface when the NAS has one. A userspace-networking NAS may bind `0.0.0.0` only behind its private LAN and Tailscale ACL/firewall boundary.
- No Garage paths, existing shares, or existing containers are used.

## Host layout

Each NAS gets a new private directory:

```text
<replica-root>/
  compose.yaml
  Dockerfile
  server.py
  .env                 # host-specific; not committed
  data/
    critical.db
    sync-state.json
```

Copy `replication.env.example` to `~/.config/joelclaw/critical-search-replication.env` and fill it from verified live topology. Install with `scripts/install-critical-search-replicas.sh`. Docker/Container Manager elevation is host-specific. The installer stages files and reports the exact blocked start command when non-interactive elevation is unavailable.

## API

- `GET /health` checks schema v2, FTS5 availability, and sync state. It returns projection freshness, sync heartbeat age, replica lag, and checksum.
- `POST /search` accepts `{query, limit?, collections?, type?}` and returns the same hit/freshness shape as the local CLI reader.
- Both endpoints require `Authorization: Bearer <token>`. The installer stores the token in mode-`0600` local and NAS config files; it never writes the token to tracked files.

The client order comes from `~/.config/joelclaw/critical-search-replicas.json`: local Flagg database, NAS-A, then NAS-B. A replica whose sync heartbeat exceeds the configured budget is skipped.
