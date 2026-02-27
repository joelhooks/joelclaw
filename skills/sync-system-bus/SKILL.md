---
name: sync-system-bus
displayName: Sync System Bus
description: "Deploy the system-bus-worker to the joelclaw Kubernetes cluster from local machine. Use when syncing changes in packages/system-bus to k8s, especially because the GitHub Actions deploy job targets a non-existent self-hosted runner and cannot complete deploys automatically."
version: 2.0.0
author: Joel Hooks
tags: [joelclaw, system-bus, kubernetes, deploy, ghcr, inngest]
---

# Sync System Bus Worker

Deploy `system-bus-worker` to the local joelclaw k8s cluster (Talos v1.12.4 / k8s v1.35.0).

**Important:** `.github/workflows/system-bus-worker-deploy.yml` has a deploy job on `self-hosted`. That runner does not exist, so deploys must be completed locally.

## Quick Deploy

The publish script handles everything — build, auth, push, k8s apply, rollout, verification:

```bash
cd ~/Code/joelhooks/joelclaw
k8s/publish-system-bus-worker.sh
```

Optional: pass a tag (defaults to timestamp):
```bash
k8s/publish-system-bus-worker.sh a6de1e0
```

## What the Script Does

1. Builds ARM64 Docker image (required — Talos/Colima node is aarch64)
2. Authenticates to GHCR via `gh auth token` (temp Docker config, auto-cleaned)
3. Pushes `ghcr.io/joelhooks/system-bus-worker:${TAG}` and `:latest`
4. Updates the image ref in `k8s/system-bus-worker.yaml`
5. `kubectl apply` the manifest
6. Waits for rollout (`--timeout=180s`)
7. Probes the new pod's health endpoint

## Post-Deploy Verification

```bash
joelclaw refresh                           # Re-register functions with Inngest
joelclaw functions | grep "<new-function>" # Verify new function appears
joelclaw status                            # Full health check
joelclaw runs --count 3                    # Confirm runs are flowing
```

## Restart Safety (ADR-0156)

The worker is stateless between Inngest steps. Each step is a separate HTTP call; Inngest stores step output server-side. This means k8s rolling restarts are safe — Inngest retries the in-flight step against the new pod.

**Critical rule: NEVER set `retries: 0` on Inngest functions.** With retries: 0, a worker restart during step execution kills the run permanently. With retries ≥ 1, Inngest retries and hits the new pod.

Current story-pipeline has `retries: 2` specifically to survive the ~1s restart window during deploys.

### What happens during deploy

```
Step executing on old pod → old pod terminates → step fails (SDK unreachable)
→ Inngest retries after backoff → new pod handles retry → step completes
```

All previously completed steps are memoized. Only the in-flight step reruns.

### Long-running steps (codex implement: 5-10 min)

If a deploy kills a codex step mid-execution, the step reruns from scratch on the new pod (5-10 min wasted but not fatal). For time-critical deploys during active loops, check `joelclaw loop status` first and deploy between stories.

## Manual Steps (if script fails)

### Build

```bash
cd ~/Code/joelhooks/joelclaw
TAG=$(git rev-parse --short HEAD)
IMAGE="ghcr.io/joelhooks/system-bus-worker:${TAG}"
docker build --platform linux/arm64 -t "$IMAGE" -t ghcr.io/joelhooks/system-bus-worker:latest -f packages/system-bus/Dockerfile .
```

### Push

```bash
gh auth token | docker login ghcr.io -u $(gh api user -q .login) --password-stdin
docker push "$IMAGE"
docker push ghcr.io/joelhooks/system-bus-worker:latest
```

### Deploy

```bash
kubectl -n joelclaw set image deployment/system-bus-worker system-bus-worker="$IMAGE"
kubectl -n joelclaw rollout status deployment/system-bus-worker --timeout=180s
```

### Verify

```bash
joelclaw refresh
joelclaw status
```

### Log

```bash
slog write --action deploy --tool system-bus-worker --detail "deployed ${IMAGE}" --reason "sync worker changes"
```

## Common Gotchas

| Problem | Cause | Fix |
|---------|-------|-----|
| `exec format error` in pod | Built for amd64, not arm64 | Rebuild with `--platform linux/arm64` |
| `docker-credential-desktop` error | Docker config has credsStore | Script uses temp config dir — if manual, remove `"credsStore": "desktop"` |
| Function missing after deploy | Not in index file | Add to both `index.host.ts` AND `index.cluster.ts` |
| Function still missing | Stale Inngest registration | `joelclaw refresh` then check again |
| "Unable to reach SDK URL" | Worker pod not ready | Wait for rollout, then `joelclaw refresh` |
| Runs stuck after deploy | `retries: 0` on the function | Set `retries: 2` minimum (ADR-0156) |
| Stale app registrations | Multiple apps registered | Delete old registrations in Inngest dashboard (`:8289`) |

## Key Paths

| What | Path |
|------|------|
| Publish script | `k8s/publish-system-bus-worker.sh` |
| Dockerfile | `packages/system-bus/Dockerfile` |
| k8s manifest | `k8s/system-bus-worker.yaml` |
| Host function index | `packages/system-bus/src/inngest/functions/index.host.ts` |
| Cluster function index | `packages/system-bus/src/inngest/functions/index.cluster.ts` |
| Worker entry | `packages/system-bus/src/serve.ts` |
| GH Actions workflow | `.github/workflows/system-bus-worker-deploy.yml` |
| ADR-0156 | `~/Vault/docs/decisions/0156-graceful-worker-restart.md` |
