---
type: adr
status: proposed
date: 2026-02-21
tags: [adr, infrastructure, storage, nas, tiering]
deciders: [joel]
supersedes: []
related: ["0029-replace-docker-desktop-with-colima", "0082-typesense-unified-search", "0083-tailscale-kubernetes-operator", "0087-observability-pipeline-joelclaw-design-system"]
---

# ADR-0088: NAS-Backed Storage Tiering

## Status

proposed

## Context

The NAS (three-body, Synology DS1621+, Intel Atom C3538, 8GB RAM) has **57TB free** and sits idle except for video archives. Meanwhile, the Mac Mini's internal SSD stores everything — Typesense indexes, Qdrant vectors, Redis persistence, git repos, session transcripts, model weights, Docker images. This is wasteful: the SSD has finite capacity, and the NAS is purpose-built for durable bulk storage.

When the Mac Studio arrives (April 10, 2026), both machines will need shared access to the same data. The NAS is the natural shared storage layer — reachable by both machines over Tailscale at `100.67.156.41`.

### Current State

| Data | Location | Size | Access Pattern |
|------|----------|------|----------------|
| Typesense indexes + HNSW vectors | k8s PVC (local-path, 5Gi) | ~1-2 GB | Random I/O, MMAP, latency-sensitive |
| Qdrant vectors | k8s PVC (local-path, 5Gi) | ~500 MB | Being retired (ADR-0077/0082) |
| Redis persistence | k8s PVC (local-path, 1Gi) | ~50 MB | Write-ahead log, latency-sensitive |
| Video archives | NAS `/volume1/home/joel/video/` | ~2 TB | Write-once, read-rarely |
| Session transcripts | `~/.claude/projects/`, `~/.pi/` | ~500 MB | Append-only, read on recall |
| Model weights (ONNX) | Typesense container, mlx-whisper cache | ~1 GB | Read-once, cache locally |
| Git repos | `~/Code/` | ~5 GB | Frequent random I/O |
| Vault | `~/Vault/` | ~100 MB | Frequent read/write |
| Daily logs + slog | `~/.joelclaw/workspace/memory/` | ~50 MB | Append-only |
| Inngest state | k8s PVC | ~200 MB | Latency-sensitive |
| Docker/OCI images | Colima VM disk | ~5 GB | Read-heavy on pull |

### NAS Capabilities

- **Hardware**: Asustor NAS (ADM OS, Linux-based, Docker capable)
- **Network**: 10GbE LAN (~1.2 GB/s wire speed, ~0.1-0.3ms NFS latency). Also reachable via Tailscale when off-LAN (slower)
- **Protocols**: NFS, SMB, SSH/rsync, iSCSI
- **HDD tier**: 8x ~10TB RAID5 → 64TB usable, 57TB free (`/volume1`, md1). All 8 disks healthy [UUUUUUUU]. ~150-250 MB/s sequential, ~1-5ms seek
- **NVMe tier**: 2x Seagate IronWolf ZP2000NM30002 NVMe (2TB each) — **currently unmounted and unused**. Can be configured in ADM as: (a) SSD read/write cache for HDD RAID, (b) separate NVMe volume (e.g. `/volume2` as RAID1 for ~2TB fast storage), or (c) raw block devices
- **Implication**: NVMe volume over 10GbE ≈ 0.1ms network + SSD-speed random I/O. Fast enough for database workloads (Typesense HNSW, potentially Redis persistence). The NAS effectively becomes two tiers: NVMe for hot shared data, HDD RAID for warm/cold. Both accessible from any machine on the 10GbE LAN. This means Tier 1 workloads CAN live on NAS (on NVMe), not just Tier 2/3

## Decision

Adopt a **three-tier storage strategy** that places data on the right medium based on its access pattern:

### Tier 1: SSD (Hot) — Latency-Sensitive

Lives on the local machine's SSD. Never on NAS. Sub-millisecond access required.

| Data | Reason |
|------|--------|
| Typesense indexes + HNSW vectors | MMAP, random I/O, auto-embedding generates vectors on write |
| Redis persistence | Write-ahead log, pub/sub latency |
| Inngest state | Step execution depends on fast state reads |
| Active git repos (`~/Code/`) | Constant random I/O from builds, LSP, agents |
| Vault (`~/Vault/`) | Obsidian reads on every note switch |

### Tier 2: NAS (Warm) — Bulk Storage, Shared Access

Mounted via NFS on all machines. Read-heavy, write-infrequent. Acceptable latency: 5-50ms.

| Data | Mount Point | NAS Path | Access Pattern |
|------|-------------|----------|----------------|
| Video archives | `/mnt/nas/video` | `/volume1/home/joel/video/` | Already here. Write-once by yt-dlp, read by transcription |
| Model weights (ONNX, Whisper) | `/mnt/nas/models` | `/volume1/data/models/` | Download once, read on cold start, cache locally |
| OCI image cache | `/mnt/nas/images` | `/volume1/data/images/` | Pull once, read on pod start |
| Typesense snapshots | `/mnt/nas/backups/typesense` | `/volume1/data/backups/typesense/` | Nightly snapshot via Typesense API |
| Convex exports | `/mnt/nas/backups/convex` | `/volume1/data/backups/convex/` | Daily export via Convex CLI |
| Meeting transcripts (Granola) | `/mnt/nas/transcripts` | `/volume1/data/transcripts/` | Write after meeting, read on recall |
| Session transcripts | `/mnt/nas/sessions` | `/volume1/data/sessions/` | Rotate from local after 7 days |

### Tier 3: NAS (Cold) — Deep Archive

Same NAS, different path. Rarely accessed. Kept for compliance, debugging, or historical analysis.

| Data | NAS Path | Retention |
|------|----------|-----------|
| otel_events (rotated from Typesense) | `/volume1/archive/otel/` | 90 days in Typesense → JSONL on NAS forever |
| Old daily logs | `/volume1/archive/memory/` | Rotate from local after 30 days |
| slog JSONL archives | `/volume1/archive/slog/` | Rotate monthly |
| Qdrant data dump (post-retirement) | `/volume1/archive/qdrant/` | One-time archive, keep 90 days |
| Old Vercel build logs | `/volume1/archive/vercel/` | From webhook events, if captured |

### NFS Mount Setup

On each machine (Mac Mini now, Mac Studio in April):

```bash
# Create mount points
sudo mkdir -p /mnt/nas/{video,models,images,backups,transcripts,sessions}
sudo mkdir -p /mnt/nas/backups/{typesense,convex,redis}
sudo mkdir -p /mnt/nas/archive/{otel,memory,slog,qdrant,vercel}

# /etc/fstab entries (Tailscale IP for mesh access)
100.67.156.41:/volume1/home/joel/video  /mnt/nas/video       nfs  soft,intr,timeo=30,retrans=3,noauto,x-systemd.automount  0  0
100.67.156.41:/volume1/data/models      /mnt/nas/models      nfs  soft,intr,timeo=30,retrans=3,noauto,x-systemd.automount  0  0
100.67.156.41:/volume1/data/images      /mnt/nas/images      nfs  soft,intr,timeo=30,retrans=3,noauto,x-systemd.automount  0  0
100.67.156.41:/volume1/data/backups     /mnt/nas/backups     nfs  soft,intr,timeo=30,retrans=3,noauto,x-systemd.automount  0  0
100.67.156.41:/volume1/data/transcripts /mnt/nas/transcripts nfs  soft,intr,timeo=30,retrans=3,noauto,x-systemd.automount  0  0
100.67.156.41:/volume1/data/sessions    /mnt/nas/sessions    nfs  soft,intr,timeo=30,retrans=3,noauto,x-systemd.automount  0  0
100.67.156.41:/volume1/archive          /mnt/nas/archive     nfs  soft,intr,timeo=30,retrans=3,noauto,x-systemd.automount  0  0
```

Key NFS options:
- `soft,intr` — don't hang processes if NAS is unreachable; return error instead
- `timeo=30,retrans=3` — 3-second timeout, 3 retries before failing
- `noauto,x-systemd.automount` — mount on first access, not at boot (macOS: use `autofs` instead of systemd)

### Backup Cron Jobs

```bash
# Typesense snapshot → NAS (daily 3 AM)
0 3 * * * curl -X POST "http://localhost:8108/operations/snapshot?snapshot_path=/data/snapshots/$(date +\%Y\%m\%d)" \
  -H "X-TYPESENSE-API-KEY: $TYPESENSE_API_KEY" && \
  rsync -az /path/to/typesense/snapshots/ /mnt/nas/backups/typesense/

# Redis RDB → NAS (daily 3:30 AM)
30 3 * * * kubectl exec -n joelclaw redis-0 -- redis-cli BGSAVE && \
  sleep 10 && \
  kubectl cp joelclaw/redis-0:/data/dump.rdb /mnt/nas/backups/redis/dump-$(date +\%Y\%m\%d).rdb

# Session transcript rotation → NAS (weekly)
0 4 * * 0 find ~/.claude/projects/ -name "*.jsonl" -mtime +7 -exec mv {} /mnt/nas/sessions/ \;
0 4 * * 0 find ~/.pi/ -name "*.jsonl" -mtime +7 -exec mv {} /mnt/nas/sessions/ \;

# Daily log rotation → NAS (monthly)
0 4 1 * * find ~/.joelclaw/workspace/memory/ -name "*.md" -mtime +30 -exec mv {} /mnt/nas/archive/memory/ \;

# slog archive → NAS (monthly)
0 4 1 * * cp ~/Vault/system/system-log.jsonl /mnt/nas/archive/slog/system-log-$(date +\%Y\%m).jsonl
```

These should be Inngest cron functions (not raw crontab) for observability and retry. Implementing as `system/backup.*` events.

### Mac Studio Migration (April 2026)

When the Mac Studio arrives:
1. Same NFS mounts in `/mnt/nas/` — identical paths on both machines
2. Tier 1 data is per-machine (each has its own SSD)
3. Tier 2/3 data is shared via NAS — both machines see the same files
4. Model weights: download once to NAS, cache locally on each machine's SSD
5. Backups: each machine backs up its own Tier 1 data to NAS independently

### Typesense Specifically

- **Live data stays on SSD** (Tier 1) — HNSW index performance depends on it
- **Expand PVC from 5Gi to 50Gi** — accommodate otel_events growth from ADR-0087
- **Nightly snapshots to NAS** (Tier 2) — Typesense's built-in snapshot API → rsync to `/mnt/nas/backups/typesense/`
- **90-day rotation for otel_events** — export old events as JSONL to `/mnt/nas/archive/otel/`, delete from Typesense

## Consequences

### Positive
- 57TB of durable storage available for all data that doesn't need sub-ms latency
- Mac Studio migration is straightforward — shared NAS paths, per-machine SSDs
- Backups are automatic and off-machine — SSD failure doesn't lose history
- Model weights shared across machines — download once
- Session transcripts preserved indefinitely (currently lost on cleanup)
- otel_events can grow unbounded in archive (Typesense keeps hot window, NAS keeps everything)

### Negative
- NFS adds operational complexity (mounts, connectivity, Synology NFS config)
- NAS unavailability degrades Tier 2 access (soft mount prevents hangs but returns errors)
- 10GbE only applies on LAN — remote access via Tailscale relay is significantly slower
- Backup cron jobs need monitoring (should be Inngest functions for observability)
- macOS NFS client is historically flaky — may need autofs tuning

### Risks
- NAS disk failure without redundancy check → verify RAID status, set up Synology health alerts
- Off-LAN access via Tailscale relay is much slower than 10GbE LAN → Tier 2 reads may stall if NAS is accessed remotely. Not a concern for the always-on Mac Mini, but matters for laptop access
- 10GbE opens the door to running more workloads directly on NAS in the future (e.g., Typesense with SSD cache for HNSW + NAS for raw data, or Postgres on NAS with SSD WAL). Evaluate as data grows
- NFS file locking issues with concurrent writers → only one machine writes to any given NAS path

## Implementation Plan

### Phase 1: NAS Setup (day 1)
1. Enable NFS on Synology DSM (`Control Panel → File Services → NFS`)
2. Create shared folders: `/volume1/data/`, `/volume1/archive/`
3. Set NFS permissions for Mac Mini's Tailscale IP (`100.x.x.x`)
4. Test mount from Mac Mini: `sudo mount -t nfs 100.67.156.41:/volume1/data /mnt/nas/data`
5. Configure autofs for persistent auto-mounts

### Phase 2: Backup Jobs (day 2)
6. Create `system/backup.typesense` Inngest function (daily snapshot + rsync)
7. Create `system/backup.redis` Inngest function (daily RDB copy)
8. Create `system/rotate.sessions` Inngest function (weekly transcript rotation)
9. Create `system/rotate.logs` Inngest function (monthly log archive)
10. Wire all backup functions into heartbeat monitoring

### Phase 3: Tier 2 Migration (day 3)
11. Move model weights to NAS, create local cache symlinks
12. Configure video pipeline to write directly to NAS mount (already does via SSH — switch to NFS)
13. Expand Typesense PVC from 5Gi to 50Gi

### Phase 4: Mac Studio Prep (before April 10)
14. Document NFS mount setup as repeatable script
15. Test NFS access from second Tailscale node
16. Plan Tier 1 data seeding for new machine (Typesense re-index from NAS snapshots)

## Verification

- [ ] `ls /mnt/nas/video/` shows video archive from Mac Mini
- [ ] `ls /mnt/nas/backups/typesense/` shows dated snapshot directories after first backup run
- [ ] NAS mount survives Mac Mini reboot (autofs reconnects on access)
- [ ] `soft,intr` NFS options confirmed: disconnect NAS → NFS operations fail fast (no hung processes)
- [ ] Typesense PVC shows 50Gi capacity: `kubectl get pvc -n joelclaw`
- [ ] Backup Inngest functions visible in `joelclaw functions` output

## References

- ADR-0029: Colima + Talos k8s (where PVCs live)
- ADR-0082: Typesense unified search (primary Tier 1 consumer)
- ADR-0083: Tailscale k8s operator (future: services get own Tailscale identity, NAS access simplifies)
- ADR-0087: Observability pipeline (otel_events will be largest Typesense collection, needs rotation to NAS)
- NEIGHBORHOOD.md: NAS specs and network topology
