---
type: adr
status: accepted
date: 2026-02-21
tags: [adr, infrastructure, storage, nas, tiering]
deciders: [joel]
supersedes: []
related: ["0029-replace-docker-desktop-with-colima", "0082-typesense-unified-search", "0083-tailscale-kubernetes-operator", "0087-observability-pipeline-joelclaw-design-system"]
---

# ADR-0088: NAS-Backed Storage Tiering

## Status

accepted — Phase 1 is complete and backup rollout has begun; remaining migration and Mac Studio readiness work is still tracked below.

## Context

The NAS (three-body, Asustor ADM OS) has **57TB free** on HDD RAID5 and **1.78TB** on NVMe RAID1, sitting mostly idle. Meanwhile, the Mac Mini's internal SSD stores everything. When the Mac Studio arrives (April 10, 2026), both machines will need shared access to the same data. The NAS is the natural shared storage layer — reachable by both machines over 10GbE LAN.

### Hardware

- **NAS**: Asustor (ADM OS, Linux-based, Docker capable)
- **HDD tier**: 8x ~10TB RAID5 (md1) → 64TB usable, 57TB free. ~150-250 MB/s sequential
- **NVMe tier**: 2x Seagate IronWolf ZP2000NM30002 2TB in RAID1 (md2) → 1.78TB usable. 824 MiB/s local write
- **Network**: 10GbE LAN, MTU 9000 (jumbo frames) on NAS eth2 + Mac en0
- **NFS performance** (tuned): Write ~660 MiB/s, Read ~1,000 MiB/s over NFS
- **NVMe dirs**: `/volume2/data/{typesense,redis,models,backups,sessions,transcripts,otel}`

### Soak Test Results (all gates passed)

- ✅ G1: Zero NFS failures over 48h
- ✅ G2: md2 RAID1 resync complete — [2/2] [UU]
- ✅ G3: Local NVMe write 824 MiB/s ≥ 700 MiB/s threshold

### NFS Tuning Applied

| Setting | Before | After | Impact |
|---------|--------|-------|--------|
| MTU | 1500 | 9000 (jumbo frames) | Fewer packet headers |
| rsize/wsize | 32KB | 1MB | Fewer NFS round-trips |
| readahead | 16 | 128 | Aggressive prefetch |
| noatime | off | on | Skip access time updates |

Persistent via LaunchDaemons: `com.joel.mtu-jumbo.plist` (MTU) + `com.joel.mount-nas-nvme.plist` (NFS mount).

## Decision

Three-tier storage strategy placing data on the right medium based on access pattern.

### Tier 1: SSD (Hot) — Latency-Sensitive

Lives on the local machine's SSD. Sub-millisecond access required.

| Data | Reason |
|------|--------|
| Redis persistence | Write-ahead log, pub/sub latency |
| Inngest state | Step execution depends on fast state reads |
| Active git repos (`~/Code/`) | Constant random I/O from builds, LSP, agents |
| Vault (`~/Vault/`) | Obsidian reads on every note switch |

> **Typesense**: Currently Tier 1 (local SSD via k8s PVC). NAS NVMe performance (660 MiB/s write, 1 GB/s read) makes NAS viable for Typesense if shared access between machines is needed. Decision deferred to Mac Studio arrival — evaluate after testing Typesense directly on NAS NVMe.

### Tier 2: NAS NVMe (Warm-Hot) — Shared Fast Storage

Mounted via NFS at `/Volumes/nas-nvme`. Both Mac Mini and Mac Studio access the same data.

| Data | NAS Path | Access Pattern |
|------|----------|----------------|
| Model weights (ONNX, Whisper) | `/volume2/data/models/` | Download once, read on cold start |
| Typesense snapshots | `/volume2/data/backups/` | Nightly snapshot |
| Session transcripts | `/volume2/data/sessions/` | Rotate from local after 7 days |
| Meeting transcripts | `/volume2/data/transcripts/` | Write after meeting, read on recall |
| OTEL event archives | `/volume2/data/otel/` | Rotated from Typesense after 90 days |

### Tier 3: NAS HDD (Cold) — Deep Archive

Mounted via NFS at `/Volumes/three-body`. Rarely accessed.

| Data | NAS Path | Retention |
|------|----------|-----------|
| Video archives | `/volume1/home/joel/video/` | Already here. Permanent |
| Old daily logs | `/volume1/joelclaw/archive/memory/` | Rotate from local after 30 days |
| slog JSONL archives | `/volume1/joelclaw/archive/slog/` | Rotate monthly |
| Qdrant data dump (post-retirement) | `/volume1/joelclaw/archive/qdrant/` | One-time, keep 90 days |
| Books | `/volume1/home/joel/books/` | Permanent |

### NFS Mount Setup (macOS Tahoe)

macOS Tahoe has read-only root (`/mnt` not writable). Use `/Volumes/` for mount points. `vifs` cannot create `/etc/fstab`. LaunchDaemons are the persistent mount solution.

Mount points:
- `/Volumes/nas-nvme` → `three-body:/volume2/data` (NVMe RAID1)
- `/Volumes/three-body` → `<private-ip>:/volume1/joelclaw` (HDD RAID5)

Mount options: `resvport,rw,soft,intr,nfsvers=3,tcp,rsize=1048576,wsize=1048576,readahead=128,noatime`

**Critical macOS NFS notes:**
- `soft,intr` **required** — hard mounts (default) hang permanently on NAS restart, need full Mac reboot to clear
- `nfsvers=3` — NFSv4 has issues with Asustor ADM
- UID mismatch: NAS joel=1002, Mac joel=501. `no_root_squash` + `chmod 777` on NFS dirs as workaround

### Backup Inngest Functions (not raw crontab)

All backup jobs run as Inngest cron functions for observability, retry, and gateway alerting.

| Function | Schedule | Action |
|----------|----------|--------|
| `system/backup.typesense` | Daily 3 AM | Typesense snapshot API → rsync to NAS NVMe |
| `system/backup.redis` | Daily 3:30 AM | BGSAVE → kubectl cp → NAS NVMe |
| `system/backup.convex` | Daily 4 AM | Convex export → NAS NVMe |
| `system/rotate.sessions` | Weekly Sunday | Move transcripts older than 7 days to NAS |
| `system/rotate.logs` | Monthly 1st | Archive daily logs + slog to NAS HDD |
| `system/rotate.otel` | Monthly 1st | Export old otel_events as JSONL → NAS, delete from Typesense |

### Mac Studio Migration (April 2026)

1. Same NFS mounts at `/Volumes/nas-nvme` and `/Volumes/three-body` — identical paths
2. Same LaunchDaemons — copy plists, adjust interface name for MTU if different
3. Tier 1 data is per-machine (each has its own SSD)
4. Tier 2/3 data is shared via NAS — both machines see the same files
5. Setup checklist: `~/Vault/docs/mac-setup-checklist.md`

## Implementation Progress

### Phase 1: NAS Setup ✅
- [x] NVMe RAID1 created (md2, 2x 2TB, 1.78TB usable)
- [x] Btrfs filesystem on NVMe volume
- [x] NFS exports configured (`<private-subnet>` CIDR)
- [x] NFS mount on Mac Mini with LaunchDaemon
- [x] Jumbo frames (MTU 9000) on both ends
- [x] NFS tuning: rsize/wsize 1MB, readahead 128, noatime
- [x] Soak test: all 3 gates passed
- [x] Performance verified: 660 MiB/s write, 1 GB/s read

### Phase 2: Backup Jobs (next)
- [ ] `system/backup.typesense` Inngest function
- [ ] `system/backup.redis` Inngest function
- [ ] `system/backup.convex` Inngest function
- [ ] `system/rotate.sessions` Inngest function
- [ ] `system/rotate.logs` Inngest function
- [ ] `system/rotate.otel` Inngest function
- [ ] Wire all into heartbeat monitoring

### Phase 3: Tier 2 Migration
- [ ] Move model weights to NAS NVMe, local cache symlinks
- [ ] Video pipeline: switch from SSH to NFS mount for writes
- [ ] Expand Typesense PVC from 5Gi to 50Gi

### Phase 4: Mac Studio Prep (before April 10)
- [x] Mac setup checklist documented (`~/Vault/docs/mac-setup-checklist.md`)
- [ ] Test NFS access from second machine
- [ ] Plan Tier 1 data seeding (Typesense re-index from snapshots)

## Consequences

### Positive
- 57TB HDD + 1.78TB NVMe of durable shared storage
- Both machines access same data via NFS — no rsync/duplication
- Backups are automatic, observable (Inngest), and off-machine
- NFS performance (660 MiB/s write, 1 GB/s read) viable for most workloads
- Session transcripts and OTEL events preserved indefinitely

### Negative
- NFS adds operational complexity (mounts, connectivity)
- NAS unavailability degrades Tier 2 access (soft mount returns errors, doesn't hang)
- macOS NFS client historically flaky — mitigated by soft,intr + LaunchDaemon retry
- UID mismatch workaround (chmod 777) is not ideal

### Risks
- NAS disk failure → RAID5 (HDD) and RAID1 (NVMe) provide redundancy. Monitor via ADM alerts
- Off-LAN access via Tailscale relay much slower than 10GbE LAN → only affects laptop, not always-on nodes
- NFS file locking with concurrent writers → only one machine writes to any given path

## Audit (2026-02-22)

- Status normalized to `accepted` (from `partially-implemented`) to match canonical ADR taxonomy while preserving the staged rollout state.
- Operational evidence reviewed from `system/system-log.jsonl`:
  - `2026-02-21T15:22:40.529Z` (`tool: nas-nvme`) NVMe RAID1 + directory topology created per ADR.
  - `2026-02-21T15:40:58.023Z` (`tool: nas-nfs`) NFS exports + mounts configured for `/volume2/data` and `/volume1/joelclaw`.
  - `2026-02-21T21:50:17.009Z` (`tool: nas-nfs`) MTU/NFS tuning deployed with measured throughput gains.
  - `2026-02-21T22:05:38.918Z` (`action: deploy`, `tool: nas-backup`) Phase 2 backup/rotation crons deployed to NAS NVMe.
- Phase 3/4 migration and validation tasks remain open in this ADR, so status is not upgraded to `implemented`.

## References

- ADR-0029: Colima + Talos k8s (where PVCs live)
- ADR-0082: Typesense unified search (primary Tier 1 consumer)
- ADR-0087: Observability pipeline (otel_events rotation to NAS)
- `~/Vault/docs/mac-setup-checklist.md`: Full machine setup guide
- `~/.joelclaw/NEIGHBORHOOD.md`: NAS specs and network topology
