# AIStor Migration Runbook (k8s)

Date: 2026-03-04

## Why this exists

`minio/minio` OSS is archived and no longer maintained. We keep legacy MinIO online for rollback while introducing AIStor in parallel.

## Current topology

- Legacy MinIO (namespace `joelclaw`)
  - Service: `minio` (ClusterIP 9000/9001)
  - NodePort: `minio-nodeport` (30900/30901)
- AIStor (namespace `aistor`)
  - Operator release: `aistor`
  - ObjectStore release: `aistor-primary`
  - S3 API service: `aistor-s3-api` (NodePort 31000, TLS)
  - Console service: `aistor-s3-console` (NodePort 31001, TLS)

## Deploy / reconcile

```bash
cd ~/Code/joelhooks/joelclaw
./k8s/reconcile-aistor.sh
```

The script leases `aistor_key` from `secrets`, deploys/updates operator + objectstore, writes runtime config secret, and waits for `aistor-s3-pool-0` rollout.

## Validation

```bash
kubectl get pods -n aistor
kubectl get svc -n aistor
kubectl get svc -n joelclaw | rg minio
```

Optional Restate smoke test against AIStor:

```bash
MINIO_NAMESPACE=aistor \
MINIO_SERVICE_NAME=aistor-s3-api \
MINIO_USE_SSL=true \
scripts/restate/test-workflow.sh
```

## Critical gotcha

Do **not** deploy AIStor objectstore into `joelclaw` unless intentionally cutting over. It can claim `svc/minio` and collide with legacy MinIO service naming.

Legacy MinIO remains on `minio/minio:latest` for rollback because source-only-era release tag `RELEASE.2025-10-15T17-29-55Z` is not pullable from Docker Hub in this cluster.

Legacy rollback storage mounts the exported NAS root (`/volume1/joelclaw`) via NFSv3 and uses `subPath: s3` inside the pod. The NAS export itself does not expose `/volume1/joelclaw/s3` directly.

If that happens:

```bash
helm uninstall aistor-primary -n joelclaw
kubectl apply -f k8s/minio-pv.yaml -f k8s/minio.yaml
./k8s/reconcile-aistor.sh
```

`reconcile-aistor.sh` refuses `AISTOR_OBJECTSTORE_NAMESPACE=joelclaw` unless you set `AISTOR_ALLOW_JOELCLAW_NAMESPACE=true`.
