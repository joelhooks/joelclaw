# Flagg Gate 5 staged migration plan

Gate 5 is the Flagg **Central** cutover phase for ADR-0246.

This plan reconciles two constraints:

1. Joel wants to migrate and smoke-test services individually.
2. ADR-0246 forbids long-lived split-brain Central.

The safe shape is **staged proof, atomic authority**: rehearse and smoke-test each service individually, but do not leave Panda and Flagg sharing authoritative Central ownership. Stateful authority flips only inside an approved cutover window with Panda writes frozen.

## Status

Draft plan. Do not execute without explicit go/no-go.

Project Thread for approvals, milestone updates, blockers, and smoke-test evidence:

- https://eggheadio.slack.com/archives/C09LKT871PE/p1779975813335049

Gate 4 is complete: Flagg shadow Central recovered after hard reboot with no GUI login.

Gate 5 Phase A stateful-service shadow smoke passed on 2026-05-28. Receipt on Flagg:

```text
/Users/Shared/joelclaw/logs/central/smoke/phase-a-20260528T162118Z.log
```

Verified services: Redis, Typesense, Inngest, Restate, and MinIO. This was shadow-only; Panda was not frozen and no endpoints were flipped.

Gate 5 is not complete until Flagg owns Central state, workers, endpoints, and verification while Panda is frozen as rollback-only.

## Definitions

- **Shadow smoke test**: a test against Flagg using shadow data or isolated writes. Safe before cutover.
- **Migration rehearsal**: a repeatable state copy into Flagg while Panda remains authoritative. Safe if Flagg services do not feed live Central clients.
- **Authority flip**: the moment a service becomes the source of truth for Central. Requires the write freeze gate.
- **Rollback point**: the latest state from which Panda can still resume cleanly without replaying Flagg writes.
- **Split-brain**: any state where Panda and Flagg both accept authoritative Central writes for the same service family. Forbidden.

## What “refactoring the deploy system” means

Avoid this during Gate 5 unless a blocker forces it:

- replacing the deploy abstraction,
- rebuilding CI/CD around the new host,
- changing how `joelclaw deploy` works,
- rewriting service discovery,
- replacing worker packaging,
- adding a new supervisor/runtime family,
- generalizing Flagg migration scripts into a universal platform.

Gate 5 can add small, boring scripts if needed for migration proof. It should not become “while we are here, let's rebuild deployment.” That is how a migration turns into a swamp with receipts.

## What “making Flagg perfect” means

Good idea. Wrong gate.

Create a post-cutover hardening backlog instead of blocking Central migration on perfection:

- demote Joel from admin after confidence window,
- verify backup/restore with a real restore drill,
- add service-native export/import for Redis, Typesense, MinIO, and Restate where needed,
- improve health summaries and OTEL dashboards,
- make worker deployment boring from one command,
- harden secrets and move toward the Credential Proxy direction from `CONTEXT.md`,
- clean Flagg GitHub SSH/fetch,
- prune shadow leftovers,
- document “remote dev box, not service owner” boundaries.

Perfection is a Phase 6/hardening board, not a Gate 5 prerequisite.

## Gate 5 state machine

```mermaid
stateDiagram-v2
  [*] --> ShadowReady
  ShadowReady --> Rehearsing: per-service smoke tests
  Rehearsing --> ShadowReady: reset shadow data
  Rehearsing --> GoNoGo: all smoke tests pass
  GoNoGo --> Rehearsing: not approved
  GoNoGo --> FreezePanda: explicit approval
  FreezePanda --> FinalSnapshot
  FinalSnapshot --> FinalSync
  FinalSync --> FlipEndpoints
  FlipEndpoints --> StartFlaggWorkers
  StartFlaggWorkers --> VerifyCentral
  VerifyCentral --> ObserveRollbackWindow
  ObserveRollbackWindow --> Shipped: rollback window closes

  FreezePanda --> RollbackPanda: pre-flip failure
  FinalSync --> RollbackPanda: sync failure
  FlipEndpoints --> RollbackPanda: endpoint failure before Flagg writes
  StartFlaggWorkers --> RollbackPanda: worker failure before Flagg writes
  VerifyCentral --> ReplayOrForwardFix: Flagg writes happened
  ReplayOrForwardFix --> ObserveRollbackWindow

  RollbackPanda --> ShadowReady
```

The nasty edge: once Flagg accepts authoritative writes, rollback is no longer a simple flip-back. It becomes replay/repair. That is the line we do not cross casually.

## Service order

### Phase A — shadow service smoke tests

These can run before cutover. They prove Flagg services are alive and compatible without making them authoritative.

| Order | Service | Shadow smoke test | Split-brain risk |
| --- | --- | --- | --- |
| 1 | Redis | `PING`, test isolated key write/read/delete, inspect persistence after restart | Low if test keys are namespaced and no live clients point at it |
| 2 | Typesense | `/health`, create temp collection, import/search/delete temp docs | Low if temp collection only |
| 3 | Inngest | `/health`, dev-server/API reachability, worker registration smoke against Flagg-only endpoint | Medium if live events point here early |
| 4 | Restate | ingress/admin/metrics ports, register temp service, invoke no-op workflow if available | Medium if live workers use mixed Restate/Redis/Inngest |
| 5 | MinIO | ready health, temp bucket/object write/read/delete | Low if temp bucket only |
| 6 | system-bus-worker | start against Flagg env in isolated mode, verify `/api/inngest`, do not register against Panda | High if it consumes live Panda events while writing Flagg state |
| 7 | restate-worker | start against Flagg Restate in isolated mode, run no-op DAG | High if it drains live Panda queues |
| 8 | gateway bridge | send a private test notification through Flagg path only | High if inbound channels are double-consumed |
| 9 | Run capture/search | capture a test Run to Flagg, search it, delete/reset if needed | High if client Machines post to both Centrals |

### Phase B — migration rehearsal

Copy or rebuild data into Flagg while Panda remains authoritative.

Rules:

- Flagg remains isolated from live writers.
- Every rehearsal is idempotent.
- Every rehearsal has a reset path.
- Evidence is logged with timestamp, source, destination, record counts, and smoke result.

Recommended per-service rehearsal stance:

| Service | Source of truth | Rehearsal approach | Cutover stance |
| --- | --- | --- | --- |
| Redis | Panda runtime state | Snapshot/copy only if state is needed; otherwise drain/empty at cutover | Prefer drain/quiet over migrating stale queues |
| Typesense | Mixed: memory Runs rebuildable from NAS; OTEL/search collections may need export | Export/import collections or rebuild memory collections from NAS | Must know which collections are authoritative vs derived |
| Inngest | Panda event/run DB | Prefer drain active runs, then start Flagg clean unless history is required | Do not dual-deliver events |
| Restate | Panda workload journal | Prefer no active jobs at cutover; do not migrate poisoned/active journals casually | Drain/cancel workloads before flip |
| MinIO | Object data if still used | Bucket sync / object inventory diff | Only include wave 1 buckets actually used by Central |
| Workers | Code + env | Start against Flagg services after state is staged | Workers start after stateful services are Flagg-authoritative |
| Gateway | Channel ingress + queue bridge | Private test path only | Inbound channels flip last |
| Runs/memory | NAS + Typesense | Rebuild/import search index; capture test Run | Capture endpoint flips after Flagg search works |

### Phase B inventory dry-run — 2026-05-28

Read-only Panda inventory found:

| Service | Panda state observed | Gate 5 stance |
| --- | --- | --- |
| Redis | 26 keys in db0: 11 `joelclaw:*`, 9 `memory:*`, 2 `health:*`, plus `nas:*`, `knowledge:*`, `heartbeat:*`, `granola:*`. Queue state includes `joelclaw:queue:events` stream length 141 and `joelclaw:queue:priority` zset size 141; consumer group `joelclaw:queue:system-bus` has lag 141 and pending 0. | Snapshot/copy only after freeze if preserving gateway/runtime continuity. Do not blindly replay the 141 queued events; drain or explicitly discard stale queue entries. Health/heartbeat/watchdog timestamps can start clean. |
| Typesense | 22 collections, largest: `otel_events` 1,972,228 docs, `docs_chunks_v2` 228,939, `slack_messages` 33,262, `memory_observations` 28,046, `run_chunks_dev` 18,362, `runs_dev` 11,064. No aliases. Typesense resident memory ~5.0GB. | Export/import or rebuild by collection. Treat `runs_dev`, `run_chunks_dev`, `memory_observations`, `otel_events`, `gateway_behavior_history`, and `machines_dev` as continuity candidates. Rebuild obvious derived indexes (`docs*`, `vault_notes`, `blog_posts`, `system_knowledge`) where source-of-truth replay is cheaper and safer. |
| Inngest | `/data/main.db` is 17.5GB. Tables: 2 apps, 155 functions, 221,060 events, 98,093 runs, 96,835 finishes, 1,481,631 history rows, 1,198,599 traces, 2,113,373 spans. Last event/run timestamps are 2026-05-20. There are 1,258 unfinished runs; top unfinished are `queue/observer` 697, `slack-channel-backfill` 174, `memory/run.captured` 107, `channel-message-classify` 105, `system/content-sync` 73. | Prefer archive/snapshot Panda Inngest DB and start Flagg clean after drain/freeze. Migrating the 17.5GB DB would preserve history but also carries stale unfinished work. The unfinished set needs explicit cancel/discard decision before cutover. |
| Restate | Admin API reports `services: []`, `deployments: []`; `/restate-data` is 840KB with only cluster marker observed. | Start clean. No workload journal migration needed unless new jobs appear before cutover. |
| MinIO | No MinIO/Aistor/S3 resources in Panda k8s, no listening host ports 9000/9001/30900/30901/31000/31001. Repo manifest exists but is not applied. | Start clean or omit from wave 1 unless another object-store source is identified. |

This inventory created temporary read-only SQLite inspection pods for Inngest and deleted them immediately after logs were collected. No Panda freeze, endpoint flip, queue drain, data copy, or cutover happened.

### Flagg NAS persistence check — 2026-05-28

Flagg can resolve and reach `three-body` over the network:

- DNS/ping: ok
- NFS `2049/tcp`: reachable
- SSH `22/tcp`: reachable
- route to `192.168.1.163` uses `en10`, which reports `10Gbase-T <full-duplex,flow-control>`

But Flagg is **not** storage-ready yet:

- route MTU currently reports `1500`, not the ADR-0088 jumbo-frame target
- no `/Volumes/nas-nvme` mount
- no `/Volumes/three-body` mount
- no NFS/SMB mount in `mount`
- no `/etc/auto_*` map entry for `three-body`
- no matching system LaunchDaemon

Gate 5 should not assume NAS-backed rebuilds, artifact reads, backups, or object storage work on Flagg until the NAS path is installed and reboot-proven.

### Gate 5 NAS/object-storage target

MinIO should be an interface to `three-body`, not a pile of object data hidden on Flagg's local SSD. Local MinIO storage under `/Users/Shared/joelclaw/services/minio` is shadow-smoke-only.

Target tiering:

| Tier | Path | Backing storage | Use |
| --- | --- | --- | --- |
| Local SSD | `/Users/Shared/joelclaw/services/*` | Flagg internal SSD | Redis, Inngest, Restate, active Typesense, caches/scratch |
| NAS NVMe | `/Volumes/nas-nvme` | `three-body:/volume2/data` | fast shared artifacts, snapshots, models, docs artifacts, sessions, transcripts, hot object data |
| NAS HDD | `/Volumes/three-body` | `three-body:/volume1/joelclaw` | archives, books, bulk object data, cold retention |

Do not mix NAS NVMe and NAS HDD into one opaque MinIO erasure set. Preferred shape is either:

1. two explicit S3 surfaces: hot MinIO backed by NAS NVMe and cold MinIO backed by NAS HDD; or
2. one hot MinIO surface backed by NAS NVMe plus explicit lifecycle/copy jobs to NAS HDD.

Before cutover, prove the selected shape with:

- persistent no-login mounts for `/Volumes/nas-nvme` and `/Volumes/three-body`, or an explicitly scoped fallback for non-MinIO backup/export paths;
- route/MTU proof showing Flagg uses 10GbE to `three-body`, not Tailscale/Wi-Fi;
- read/write latency and throughput receipts against both NAS tiers;
- MinIO bucket/object smoke tests that prove writes land on NAS-backed storage.

Repo-managed NAS proof scripts now live under `infra/central/scripts/`:

- `install-nas-mounts.sh` — installs the root `com.joelclaw.central.nas-mounts` LaunchDaemon and prepares `/Volumes/nas-nvme` + `/Volumes/three-body`.
- `mount-nas.sh` — mount/status/unmount action with route, NFS, 10GbE media, and MTU checks.
- `verify-nas.sh` — non-privileged proof script for route/media/MTU/mounts plus optional write/read benchmarks against `CENTRAL_MINIO_HOT_DATA` and `CENTRAL_MINIO_COLD_DATA`.
- `smoke/nas.sh` — smoke harness wrapper for NAS write probes when `CENTRAL_REQUIRE_NAS=1`.

The NAS mount lifecycle is: `boot/kickstart -> wait_for_route -> assert_10gbe_media -> mount_nas_nvme -> mount_nas_hdd -> verify_mounts -> ready | failed_retry_next_interval`.

### Phase C — coordinated authority cutover

This is the actual Gate 5.

Preconditions:

- Joel approves the go/no-go.
- Project Thread is approved or explicitly declined.
- Panda health is green enough to snapshot.
- Flagg Gate 4 reboot proof remains valid.
- Flagg shadow smoke tests pass.
- Flagg has a documented and reboot-proven `three-body` NAS access path, including `/Volumes/nas-nvme`, `/Volumes/three-body`, 10GbE route proof, and performance receipt.
- Active loops/runs/workloads are drained, cancelled, or explicitly accepted as disposable.
- Rollback commands are written before the freeze.

Cutover sequence:

1. Announce cutover start and freeze window.
2. Stop/disable Panda write-producing workers.
3. Stop loop/workload dispatch.
4. Snapshot Panda state.
5. Final-sync selected state to Flagg.
6. Start/verify Flagg stateful services.
7. Flip Central endpoint config to Flagg.
8. Start Flagg workers.
9. Send a known event through Flagg.
10. Verify Inngest run execution on Flagg.
11. Verify Restate workload no-op on Flagg.
12. Verify OTEL emit/query on Flagg.
13. Verify Run capture/search on Flagg.
14. Verify gateway notification path.
15. Keep Panda frozen as rollback-only until rollback window closes.

## Acceptance criteria

- [x] Each stateful service has a shadow smoke-test receipt. Flagg receipt: `/Users/Shared/joelclaw/logs/central/smoke/phase-a-20260528T162118Z.log`.
- [ ] Each stateful service has a rehearsal/reset path or an explicit “start clean” decision.
- [ ] Panda write freeze procedure is documented and tested dry-run where safe.
- [ ] Active Panda workloads are drained/cancelled before final sync.
- [ ] Flagg owns Redis, Typesense, Inngest, Restate, MinIO wave-1 state after cutover.
- [ ] Flagg workers execute against Flagg state only.
- [ ] Flagg has reboot-proven NAS access to `three-body` for rebuilds/artifacts/backups/object storage, with 10GbE route proof and latency/throughput receipts.
- [ ] MinIO wave-1 data is NAS-backed, not local Flagg SSD, or MinIO is explicitly omitted from wave 1.
- [ ] Clients and relay paths post to Flagg Central only.
- [ ] Panda Central stack is stopped/frozen and labelled rollback-only.
- [ ] At least one known event completes through Flagg Inngest.
- [ ] At least one no-op workload completes through Flagg Restate.
- [ ] OTEL emit/query works through Flagg.
- [ ] Run capture/search works through Flagg.
- [ ] Gateway can notify Joel through the Flagg path.
- [ ] Post-cutover hard-reboot/no-GUI proof still passes.
- [ ] ADR-0246 is updated from `accepted` to `shipped` only after verification.

## Out of scope for Gate 5

- Demoting Joel from admin.
- Migrating PDS unless explicitly added to wave 1.
- Replacing launchd + Colima/Compose with a different runtime.
- Rewriting `joelclaw deploy`.
- Creating active/active Central.
- Making Panda a hot Central fallback.
- Full Credential Proxy hardening.
- Perfect dashboards.
- Cleaning every historical Panda artifact.

## Open decisions

1. Which Typesense collections must be exported/imported vs rebuilt from NAS?
2. Is Inngest run history worth migrating, or do we drain and start clean?
3. Is Restate journal migration worth attempting, or do we require no active workloads?
4. Which MinIO buckets are actually wave 1?
5. Does gateway move in Gate 5 or remain on Panda as Relay while pointing at Flagg Central?
6. What is the rollback window cutoff after Flagg accepts writes?
7. Should we create a `#brain-joel` Project Thread for Gate 5 evidence?
8. Should Flagg use LaunchDaemon-mounted NFS or autofs for `/Volumes/nas-nvme` and `/Volumes/three-body`?
9. Should MinIO wave 1 use two explicit hot/cold S3 surfaces, or one hot S3 surface plus lifecycle/copy jobs to HDD?

## Phase A smoke harness

Repo-managed scripts live under `infra/central/scripts/smoke/`:

- `redis.sh` — isolated temp key write/read/delete.
- `typesense.sh` — temp collection create/index/search/delete.
- `inngest.sh` — health check plus isolated `central/smoke.test` event submit.
- `restate.sh` — ingress/admin/metrics reachability.
- `minio.sh` — temp bucket/object write/read/delete through the S3 API.
- `nas.sh` — route/mount/write-probe check; included automatically when `CENTRAL_REQUIRE_NAS=1`.
- `run.sh` — aggregate harness that writes a receipt under `${CENTRAL_LOG_DIR}/smoke/`.

Run from Flagg's service checkout as the `joelclaw` service user so `.env` stays private and readable only to the runtime identity:

```bash
ssh -t joel@flagg 'cd /Users/Shared/joelclaw/src/joelclaw && sudo -u joelclaw -H ./infra/central/scripts/smoke/run.sh'
```

This performs isolated shadow writes only. It does not freeze Panda, flip endpoints, or make Flagg authoritative.

## Recommended next work

1. Sync the NAS mount scripts to Flagg's service checkout.
2. Have Joel run the privileged install/bootstrap on Flagg:
   ```bash
   ssh -t joel@flagg 'cd /Users/Shared/joelclaw/src/joelclaw && sudo ./infra/central/scripts/install-nas-mounts.sh --bootstrap'
   ```
3. Prepare NAS object roots on `three-body` if missing/not writable. NFSv3 uses numeric uid/gid; Flagg service user `joelclaw` is `502:20`, so the NAS dirs must match that identity unless an explicit id-mapping policy exists. Because pasted one-liners get mangled, stage the repo-managed helper and run it from the already logged-in `admin` shell:
   ```bash
   scp infra/central/scripts/three-body-prepare-object-roots.sh joel@three-body:/tmp/three-body-prepare-object-roots.sh
   # On three-body as admin:
   sudo sh /tmp/three-body-prepare-object-roots.sh
   ```
4. Sync the latest NAS helpers into Flagg's service checkout, then remount after NAS-side permission changes so macOS drops stale NFS access-cache verdicts:
   ```bash
   ssh -t joel@flagg 'cd /Users/joel/Code/joelhooks/joelclaw && sudo rsync -aR infra/central/scripts/mount-nas.sh infra/central/scripts/verify-nas.sh /Users/Shared/joelclaw/src/joelclaw/ && sudo chown joelclaw:staff /Users/Shared/joelclaw/src/joelclaw/infra/central/scripts/mount-nas.sh /Users/Shared/joelclaw/src/joelclaw/infra/central/scripts/verify-nas.sh && sudo chmod 755 /Users/Shared/joelclaw/src/joelclaw/infra/central/scripts/mount-nas.sh /Users/Shared/joelclaw/src/joelclaw/infra/central/scripts/verify-nas.sh && cd /Users/Shared/joelclaw/src/joelclaw && sudo ./infra/central/scripts/mount-nas.sh unmount && sudo ./infra/central/scripts/mount-nas.sh mount'
   ```
5. Verify from Flagg, preferably as the service user:
   ```bash
   ssh -t joel@flagg 'cd /Users/Shared/joelclaw/src/joelclaw && sudo -u joelclaw -H ./infra/central/scripts/verify-nas.sh --write-probe --benchmark-mib 64'
   ```
6. Hard-reboot Flagg, then repeat `verify-nas.sh` before any GUI login.
6. Decide MinIO wave-1 shape: two hot/cold S3 surfaces, or one hot surface plus lifecycle/copy jobs to HDD.
7. Write the freeze/rollback command sheet before any final sync.
8. Decide the open questions above before scheduling Gate 5.
9. Turn the ad hoc Panda inventory probes into a repo-managed read-only inventory script if we need repeatability before the cutover window.
