# Deploy

Canonical deployment notes for joelclaw runtime services.

## Kubernetes manifests

```bash
kubectl apply -f ~/Code/joelhooks/joelclaw/k8s/
```

## Canonical launchd sources

Host launchd assets that are part of joelclaw runtime behavior belong in `infra/launchd/`, not as hand-edited one-offs under `~/Library/LaunchAgents`.

Current canonical examples include:
- `infra/launchd/com.joel.system-bus-worker.plist`
- `infra/launchd/com.joel.restate-worker.plist`
- `infra/launchd/com.joel.content-sync-watcher.plist`

When installing or repairing one of these services, prefer a symlink from `~/Library/LaunchAgents/<label>.plist` back to the repo source so launchd follows the git-tracked file.

Example for the Restate worker:

```bash
ln -sfn ~/Code/joelhooks/joelclaw/infra/launchd/com.joel.restate-worker.plist \
  ~/Library/LaunchAgents/com.joel.restate-worker.plist
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.joel.restate-worker.plist 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.joel.restate-worker.plist
```

The canonical Restate host runtime is `scripts/restate/start.sh` behind `com.joel.restate-worker`, not an ad-hoc `nohup bun run ...` shell. The wrapper loads `~/.config/system-bus.env`, forces a headless-safe channel (`console` is downgraded to `noop` under launchd), forwards SIGTERM to Bun, and opportunistically re-registers the deployment when the Restate admin API is reachable. The queue drainer now also self-heals by emitting `queue.drainer.stalled` and exiting non-zero when backlog remains but progress stops past `QUEUE_DRAIN_STALL_AFTER_MS`; launchd is the recovery path for that class of stall.

Example for the content watcher:

```bash
ln -sfn ~/Code/joelhooks/joelclaw/infra/launchd/com.joel.content-sync-watcher.plist \
  ~/Library/LaunchAgents/com.joel.content-sync-watcher.plist
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.joel.content-sync-watcher.plist 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.joel.content-sync-watcher.plist
```

## Dkron phase-1 scheduler (ADR-0216)

Dkron now runs in-cluster as a single-node `StatefulSet` with a `ClusterIP` API service:

- manifest: `k8s/dkron.yaml`
- peer service: `dkron-peer` (headless)
- API service: `dkron-svc` (`ClusterIP`, port `8080`)
- storage: PVC `data-dkron-0`

### Why ClusterIP first

We are **not** adding a permanent host port mapping yet. The current phase uses short-lived CLI-managed tunnels for operator access so we don't add another long-lived port-forward footgun to the stack.

### Service-name gotcha

Do **not** name the API service `dkron`.

Kubernetes injects service env vars into pods. A bare `dkron` service would inject `DKRON_*` env vars, which collides with Dkron's own config/env parsing. Use `dkron-peer` / `dkron-svc` instead.

### Deploy / verify

```bash
kubectl apply -f k8s/dkron.yaml
kubectl rollout status statefulset/dkron -n joelclaw
kubectl get pods -n joelclaw -l app=dkron
joelclaw restate cron status
```

### Seed the tier-1 migration set

```bash
joelclaw restate cron sync-tier1 --run-now
joelclaw restate cron list
joelclaw otel search "dag.workflow.completed OR skill-garden.findings OR subscription.check_feeds.completed OR memory.digest.generate" --hours 24
```

This seeds the full ADR-0216 tier-1 set in Dkron:

- `restate-health-check`
- `restate-skill-garden`
- `restate-typesense-full-sync`
- `restate-daily-digest`
- `restate-subscription-check-feeds`

Each job uses Dkron's shell executor plus `wget` to call the Restate DAG ingress. The wrapper appends epoch seconds to the workflow ID prefix so each scheduled run is a fresh Restate workflow.

For the tier-1 migrations, the Restate shell nodes run host-side direct task runners at `scripts/restate/run-tier1-task.ts` so the scheduled job outcome reflects real work, not just event dispatch.

### Current trade-off

Dkron's upstream image still runs as root against the local-path PVC. A non-root hardening attempt failed with:

- `file snapshot store: permissions test failed`
- `open /data/raft/snapshots/permTest: permission denied`

So phase-1 keeps the pod running as-is for reliability. Harden later with either an init-permissions step, image override, or a custom image.

## Agent Runner (Cold k8s Jobs)

The agent runner executes sandboxed story runs as isolated k8s Jobs.

### Runtime Image Contract

See `k8s/agent-runner.yaml` for the full specification. Required:

- Git (checkout, diff, commit)
- Bun runtime
- Agent tooling (codex, pi, etc.)
- `/workspace` working directory
- Environment-driven configuration

### Job Generation

Jobs are created dynamically via `@joelclaw/agent-execution/job-spec`:

```typescript
import { generateJobSpec } from "@joelclaw/agent-execution";

const request: SandboxExecutionRequest = {
  workflowId: "wf-abc",
  requestId: "req-xyz",
  storyId: "story-1",
  task: "Implement feature X with tests",
  agent: { name: "codex", model: "gpt-5.4" },
  sandbox: "workspace-write",
  baseSha: "abc123",
};

const options: JobSpecOptions = {
  runtime: {
    image: "ghcr.io/joelhooks/agent-runner:latest",
    imagePullPolicy: "Always",
  },
  namespace: "joelclaw",
  imagePullSecret: "ghcr-pull",
};

const jobManifest = generateJobSpec(request, options);
// Apply with kubectl or k8s client library
```

### Job Lifecycle

1. **Creation**: Restate workflow or system-bus function generates Job spec
2. **Execution**: k8s schedules Pod, runs agent runner image
3. **Completion**: Agent emits `SandboxExecutionResult` event
4. **Cleanup**: Job auto-deletes after TTL (default: 5 minutes)

### Resource Defaults

- CPU Request: `500m`
- CPU Limit: `2`
- Memory Request: `1Gi`
- Memory Limit: `4Gi`
- Active Deadline: `1 hour`
- TTL After Completion: `5 minutes`
- Backoff Limit: `0` (no retries)

### Cancellation

To cancel a running Job:

```typescript
import { generateJobDeletion } from "@joelclaw/agent-execution";

const deletion = generateJobDeletion("req-xyz");
// kubectl delete job ${deletion.name} -n ${deletion.namespace} --propagation-policy=${deletion.propagationPolicy}
```

### Security

- Non-root execution (UID 1000, GID 1000)
- No privilege escalation
- All capabilities dropped
- RuntimeDefault seccomp profile
- Control plane toleration for single-node cluster

### Verification

After Job completion, check:

```bash
# List recent agent runner Jobs
kubectl get jobs -n joelclaw -l app.kubernetes.io/name=agent-runner

# Check Job status
kubectl describe job <job-name> -n joelclaw

# View logs
kubectl logs job/<job-name> -n joelclaw

# Check for stale Jobs (should be auto-deleted by TTL)
kubectl get jobs -n joelclaw -l app.kubernetes.io/name=agent-runner --show-all
```

### Repo Materialization and Artifact Export

**Story 3 additions:**

The agent execution package now provides clean repo materialization and auditable patch export:

#### Repo Materialization

```typescript
import { materializeRepo } from "@joelclaw/agent-execution";

// Clone or checkout repo at exact SHA in sandbox-local workspace
const result = await materializeRepo(
  "/sandbox/workspace/joelclaw",
  "abc123def456",
  {
    remoteUrl: "https://github.com/joelhooks/joelclaw.git",
    branch: "main",
    depth: 1,
    timeoutSeconds: 300,
  }
);

// result.path: materialized repo path
// result.sha: verified checkout SHA
// result.freshClone: true if cloned, false if fetched
// result.durationMs: timing data
```

**Key behaviors:**
- Fresh clone if target path doesn't exist
- Fetch + checkout if target path exists
- SHA verification after checkout
- Automatic unshallow if SHA not in shallow clone
- Isolated sandbox-local workspace (host checkout untouched)

#### Artifact Export

```typescript
import { generatePatchArtifact } from "@joelclaw/agent-execution";

// Export auditable patch artifact from sandbox run
const artifacts = await generatePatchArtifact({
  repoPath: "/sandbox/workspace/joelclaw",
  baseSha: "abc123",
  headSha: "def456", // optional, defaults to HEAD
  includeUntracked: true,
  verificationCommands: ["bun test", "bunx tsc --noEmit"],
  verificationSuccess: true,
  verificationOutput: "All checks passed",
  executionLogPath: "/tmp/execution.log",
  verificationLogPath: "/tmp/verification.log",
});

// artifacts.headSha: final SHA after execution
// artifacts.touchedFiles: list of modified/untracked files
// artifacts.patch: git patch content (format-patch or diff)
// artifacts.verification: { commands, success, output }
// artifacts.logs: { executionLog, verificationLog }
```

**Artifact contract:**
- Patch generated from baseSha..headSha range
- Touched-file inventory from `git status --porcelain`
- Verification summary and log references
- Optional untracked file inclusion
- Serializable to JSON via `writeArtifactBundle()`

#### Promotion Boundary (Phase 1)

**Authoritative output is patch bundle + metadata.**

The runtime **does not** merge to main or push to remote. Promotion is a separate decision:
- Restate workflow receives `ExecutionArtifacts`
- Operator reviews patch + verification
- Operator applies patch to host repo (or discards)
- Operator commits and pushes (if approved)

This keeps sandbox runs isolated and reversible.

### Current State

As of 2026-03-07:

- ✅ Local sandbox runner is live on the host worker via `system/agent-dispatch`
- ✅ Repo materialization helpers implemented and consumed by the live sandbox path
- ✅ Patch artifact export implemented and consumed by the live sandbox path
- ✅ Touched-file inventory capture
- ✅ Verification summary and log references in artifacts
- ✅ Gate A (non-coding) and Gate B (minimal coding) proven
- ✅ Real ADR-0217 Story 2 acceptance run completed on the sandbox path and was promoted after host-truth review
- ⏳ Cold k8s Job launcher remains the next execution gate
- ⏳ Job-level cancellation/timeouts still need the k8s runner path
- ⏳ Runtime image build, hot-image CronJob, and warm-pool scheduler remain follow-on work

The current live isolation surface is the host-worker local sandbox runner. The k8s Job contract, manifests, and resource model remain the next step rather than shipped runtime reality.
