---
title: "Kubernetes persistent storage: Ceph Rook vs SeaweedFS vs local-path"
status: proposed
date: 2026-02-17
deciders: Joel Hooks
consulted: X community advice
informed: All agents
related:
  - "[ADR-0029 — Colima + Talos](0029-replace-docker-desktop-with-colima.md)"
tags: [kubernetes, storage, infrastructure]
---

# ADR-0032: Kubernetes Persistent Storage — Ceph Rook vs SeaweedFS vs local-path

## Context and Problem Statement

The Talos cluster currently uses **local-path-provisioner** for PVCs. This was added manually (ADR-0029) because Talos doesn't bundle a storage provisioner. It works: Redis, Qdrant, and Inngest all get PVs backed by the Colima VM's disk.

Community advice (from X, Feb 2026) recommends two distributed storage options:
1. **Ceph Rook** for enterprise-grade storage
2. **SeaweedFS** as a lighter, cheaper alternative to Ceph

The question: does this cluster need distributed storage at all?

## Research Findings

### Ceph Rook — the enterprise standard

Rook is a CNCF graduated project that deploys and manages Ceph clusters on Kubernetes. Ceph provides block storage (RBD), shared filesystem (CephFS), and S3-compatible object storage (RGW) — all three storage types from one system.

**What it actually requires:**
- Minimum 3 nodes for data replication (Ceph's core value proposition)
- Each node needs raw disks (unformatted) for OSDs
- Significant resource overhead: monitors (3x), managers, OSDs per disk
- Recommended minimum per OSD node: 4 GB RAM, 1 CPU core per OSD

**Who it's for**: Multi-node bare-metal clusters where data durability across node failures matters. CERN (LHC data), Bloomberg (financial analytics), DreamWorks (media pipelines) — petabyte-scale users.

**Claim check — "enterprise stuff"**: ✅ Accurate. Ceph Rook is genuinely the gold standard for self-hosted distributed storage. The "enterprise" qualifier is fair — it's overkill for a single-node cluster but the right answer at scale.

### SeaweedFS — lighter distributed storage

SeaweedFS is a distributed storage system optimized for billions of small files. Has an official CSI driver for Kubernetes PVC support, S3-compatible API, and FUSE filesystem mount.

**Compared to Ceph:**

| Aspect | Ceph/Rook | SeaweedFS |
|--------|-----------|-----------|
| Architecture | Monitors + Managers + OSDs | Master + Volume + Filer |
| Minimum nodes | 3 (for replication) | 1 (can scale) |
| Resource overhead | Heavy (GB per OSD) | Lighter (~500 MB for basic setup) |
| Storage types | Block, File, Object | File, Object (S3) |
| PVC support | Native via CSI | Via seaweedfs-csi-driver |
| Kubernetes maturity | CNCF graduated, battle-tested | Community-maintained CSI driver |
| Operational complexity | High (Ceph is notorious) | Medium |
| Best for | Multi-node replication, enterprise | Object storage, many small files |

**Claim check — "very cheap way if you want enterprise storage"**: ⚠️ Partially accurate. SeaweedFS is cheaper to operate than Ceph and has lower resource requirements. But calling it "enterprise storage" is a stretch — it doesn't have Ceph's replication guarantees, CRUSH maps, or multi-decade battle-testing. It's a good S3-compatible storage layer, not a full enterprise storage fabric.

**CSI driver is real**: Confirmed. `seaweedfs/seaweedfs-csi-driver` on GitHub, supports dynamic provisioning, ReadWriteMany (RWX), static volumes, storage classes with replication options. Helm chart available.

### local-path-provisioner — what we have now

Uses local node disk for PVs. No replication, no distribution. If the node dies, data is gone.

**For a single-node Docker-based cluster**: This is the right answer. There's literally one node. Distributed storage across one node is a contradiction in terms.

## Decision Drivers

- **Node count**: Distributed storage requires multiple nodes. We have one.
- **Data criticality**: Redis is cache (rebuildable), Qdrant is regenerable, Inngest is ephemeral. No irreplaceable data in the cluster.
- **Resource budget**: Ceph on a single node would consume GB of RAM for zero benefit.
- **Future path**: Multi-node bare-metal changes the calculus entirely.

## Options

### Option A: Keep local-path-provisioner (status quo)

Single-node cluster, local disk, no replication. Simple and correct for the current architecture.

### Option B: Ceph Rook

Enterprise distributed storage. Requires 3+ nodes and significant resources. Overkill by orders of magnitude for current setup.

### Option C: SeaweedFS

Lighter distributed storage with S3 API. Can run on a single node but the value proposition is questionable without distribution.

### Option D: local-path now, plan for SeaweedFS or Ceph at multi-node

Keep what works. Revisit when the Pi 5 cluster exists and there are actual nodes to distribute across.

## Current Lean

**Option D.** Neither Ceph nor SeaweedFS makes sense on a single-node Docker-based cluster. The trigger for revisiting:
- Pi 5 Talos bare-metal cluster with 2+ nodes
- Data that can't be regenerated (currently everything can be)
- Need for S3-compatible object storage inside the cluster (SeaweedFS would be the lighter choice here)

If we go multi-node and need shared PVCs (ReadWriteMany), SeaweedFS is the practical choice. If we need enterprise-grade block storage with replication guarantees, Ceph Rook is the standard — but comes with serious operational complexity.

## Sources

- Rook docs: https://rook.io/docs/rook/latest/
- Rook/Ceph "gold standard" analysis: https://oneuptime.com/blog/post/2025-12-03-ceph-rook-standard-bare-metal-storage-pools/view
- SeaweedFS GitHub: https://github.com/seaweedfs/seaweedfs
- SeaweedFS CSI driver: https://github.com/seaweedfs/seaweedfs-csi-driver
- SeaweedFS vs Ceph comparison: https://onidel.com/blog/minio-ceph-seaweedfs-garage-2025
- SeaweedFS K8s deployment: https://itnext.io/minio-alternative-seaweedfs-41fe42c3f7be
- MinIO exit plan / Ceph comparison: https://kubedo.com/minio-exit-plan-ceph-s3-storage/
