#!/usr/bin/env bash
set -euo pipefail

# Self-Hosted Inngest Setup Script
# Idempotent — safe to re-run. Detects existing state and skips.
# Usage: curl -sL joelclaw.com/scripts/inngest-setup.sh | bash
#   or:  bash inngest-setup.sh [--tier 1|2|3] [--worker-dir PATH]
#
# Tiers:
#   1 = Docker only (experiment)
#   2 = Docker + persistent volume (daily driver)
#   3 = Kubernetes StatefulSet (production)
#
# After running, you still need a worker process. This script sets up the server.

TIER="${1:-}"
WORKER_DIR="${2:-./inngest-worker}"
INNGEST_PORT=8288

# ── Signing Keys (required as of Feb 2026) ───────────────
generate_keys() {
  if [ -f ".env.inngest" ]; then
    source .env.inngest
    ok "Using existing keys from .env.inngest"
  else
    INNGEST_SIGNING_KEY="signkey-dev-$(openssl rand -hex 16)"
    INNGEST_EVENT_KEY="evtkey-dev-$(openssl rand -hex 16)"
    echo "INNGEST_SIGNING_KEY=$INNGEST_SIGNING_KEY" > .env.inngest
    echo "INNGEST_EVENT_KEY=$INNGEST_EVENT_KEY" >> .env.inngest
    ok "Generated signing keys → .env.inngest"
  fi
  export INNGEST_SIGNING_KEY INNGEST_EVENT_KEY
}

# ── Helpers ──────────────────────────────────────────────
info()  { echo "▸ $*"; }
ok()    { echo "✓ $*"; }
warn()  { echo "⚠ $*"; }
fail()  { echo "✗ $*" >&2; exit 1; }

check_docker() {
  command -v docker &>/dev/null || fail "Docker not found. Install Docker Desktop, OrbStack, or Colima first."
  docker info &>/dev/null 2>&1 || fail "Docker daemon not running. Start Docker first."
  ok "Docker is running"
}

check_bun() {
  command -v bun &>/dev/null || {
    warn "Bun not found. Install: curl -fsSL https://bun.sh/install | bash"
    return 1
  }
  ok "Bun $(bun --version) found"
}

check_inngest_running() {
  if curl -sf "http://localhost:${INNGEST_PORT}" &>/dev/null; then
    ok "Inngest already running at localhost:${INNGEST_PORT}"
    return 0
  fi
  return 1
}

# ── Tier Selection ───────────────────────────────────────
if [ -z "$TIER" ]; then
  echo ""
  echo "╔═══════════════════════════════════════════════╗"
  echo "║  Self-Hosted Inngest Setup                    ║"
  echo "╠═══════════════════════════════════════════════╣"
  echo "║  1. Docker (experiment)     — no persistence  ║"
  echo "║  2. Docker (daily driver)   — survives restart║"
  echo "║  3. Kubernetes (production) — StatefulSet+PVC ║"
  echo "╚═══════════════════════════════════════════════╝"
  echo ""
  read -rp "Choose tier [1-3]: " TIER
fi

case "$TIER" in
  --tier) TIER="$2"; shift 2 ;;
esac

# ── Preflight ────────────────────────────────────────────
info "Checking prerequisites..."
check_docker
generate_keys

if check_inngest_running; then
  info "Inngest is already running. Skipping server setup."
else
  case "$TIER" in
    1)
      info "Tier 1: Docker (ephemeral)"
      docker run -d --name inngest \
        -p ${INNGEST_PORT}:${INNGEST_PORT} \
        -e INNGEST_SIGNING_KEY="$INNGEST_SIGNING_KEY" \
        -e INNGEST_EVENT_KEY="$INNGEST_EVENT_KEY" \
        inngest/inngest:latest \
        inngest start --host 0.0.0.0
      ok "Inngest running at http://localhost:${INNGEST_PORT}"
      warn "No persistent storage — container restart loses history"
      ;;

    2)
      info "Tier 2: Docker with persistent volume"
      docker run -d --name inngest \
        -p ${INNGEST_PORT}:${INNGEST_PORT} \
        -v inngest-data:/var/lib/inngest \
        -e INNGEST_SIGNING_KEY="$INNGEST_SIGNING_KEY" \
        -e INNGEST_EVENT_KEY="$INNGEST_EVENT_KEY" \
        --restart unless-stopped \
        inngest/inngest:latest \
        inngest start --host 0.0.0.0
      ok "Inngest running at http://localhost:${INNGEST_PORT}"
      ok "State persists in Docker volume 'inngest-data'"
      ;;

    3)
      info "Tier 3: Kubernetes"
      command -v kubectl &>/dev/null || fail "kubectl not found"
      
      cat <<'MANIFEST' | kubectl apply -f -
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: inngest
  namespace: default
spec:
  serviceName: inngest-svc
  replicas: 1
  selector:
    matchLabels:
      app: inngest
  template:
    metadata:
      labels:
        app: inngest
    spec:
      containers:
      - name: inngest
        image: inngest/inngest:latest
        command: ["inngest", "start", "--host", "0.0.0.0"]
        ports:
        - containerPort: 8288
        volumeMounts:
        - name: data
          mountPath: /var/lib/inngest
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: ["ReadWriteOnce"]
      resources:
        requests:
          storage: 5Gi
---
apiVersion: v1
kind: Service
metadata:
  name: inngest-svc
  namespace: default
spec:
  type: NodePort
  selector:
    app: inngest
  ports:
  - port: 8288
    targetPort: 8288
    nodePort: 8288
MANIFEST
      ok "Inngest StatefulSet + Service applied"
      warn "Service is 'inngest-svc' NOT 'inngest' — avoids INNGEST_PORT env var collision"
      ;;

    *)
      fail "Invalid tier: $TIER (expected 1, 2, or 3)"
      ;;
  esac
fi

# ── Scaffold Worker ──────────────────────────────────────
if [ -d "$WORKER_DIR" ]; then
  info "Worker directory $WORKER_DIR already exists, skipping scaffold"
else
  if check_bun; then
    info "Scaffolding worker at $WORKER_DIR"
    mkdir -p "$WORKER_DIR/src/functions"
    
    cd "$WORKER_DIR"
    bun init -y 2>/dev/null
    bun add inngest @inngest/ai hono 2>/dev/null

    cat > src/inngest.ts << 'TS'
import { Inngest, EventSchemas } from "inngest";

type Events = {
  "task/process": { data: { input: string } };
  "task/completed": { data: { input: string; result: string } };
};

export const inngest = new Inngest({
  id: "my-worker",
  schemas: new EventSchemas().fromRecord<Events>(),
});
TS

    cat > src/functions/example.ts << 'TS'
import { inngest } from "../inngest";

export const processTask = inngest.createFunction(
  { id: "process-task", concurrency: { limit: 1 }, retries: 3 },
  { event: "task/process" },
  async ({ event, step }) => {
    const result = await step.run("process", async () => {
      return `Processed: ${event.data.input}`;
    });

    await step.sendEvent("notify", {
      name: "task/completed",
      data: { input: event.data.input, result },
    });

    return { status: "done", result };
  }
);
TS

    cat > src/serve.ts << 'TS'
import { Hono } from "hono";
import { serve as inngestServe } from "inngest/hono";
import { inngest } from "./inngest";
import { processTask } from "./functions/example";

const app = new Hono();
app.get("/", (c) => c.json({ status: "running", functions: 1 }));
app.on(["GET", "POST", "PUT"], "/api/inngest",
  inngestServe({ client: inngest, functions: [processTask] })
);

export default { port: 3111, fetch: app.fetch };
TS

    ok "Worker scaffolded at $WORKER_DIR"
    info "Start with: cd $WORKER_DIR && INNGEST_DEV=1 bun run src/serve.ts"
  else
    warn "Skipping worker scaffold (no Bun). Install Bun and re-run."
  fi
fi

# ── Verify ───────────────────────────────────────────────
echo ""
info "Verification:"
sleep 2
if curl -sf "http://localhost:${INNGEST_PORT}" &>/dev/null; then
  ok "Inngest dashboard: http://localhost:${INNGEST_PORT}"
else
  warn "Inngest not responding yet — may still be starting"
fi

echo ""
echo "Next steps:"
echo "  1. Source keys:       source .env.inngest"
echo "  2. Start the worker:  cd $WORKER_DIR && INNGEST_DEV=1 bun run src/serve.ts"
echo "  3. Open dashboard:    http://localhost:${INNGEST_PORT}"
echo "  4. Send test event:   curl -X POST http://localhost:${INNGEST_PORT}/e/\$INNGEST_EVENT_KEY -H 'Content-Type: application/json' -d '{\"name\":\"task/process\",\"data\":{\"input\":\"hello\"}}'"
echo ""
