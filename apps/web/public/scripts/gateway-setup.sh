#!/usr/bin/env bash
set -euo pipefail

# Agent Gateway Setup Script
# Idempotent — safe to re-run. Detects existing state and skips.
# Usage: curl -sL joelclaw.com/scripts/gateway-setup.sh | bash
#   or:  bash gateway-setup.sh [--tier 1|2|3]
#
# Tiers:
#   1 = Notification bridge (Redis → pi extension, ~100 lines)
#   2 = Always-on with heartbeat (tmux/launchd + watchdog)
#   3 = Multi-session routing (central + satellite)
#
# Requires: pi coding agent, Redis running, npm/bun

TIER="${1:-}"
PI_EXT_DIR="${HOME}/.pi/agent/extensions/gateway"

# ── Helpers ──────────────────────────────────────────────
info()  { echo "▸ $*"; }
ok()    { echo "✓ $*"; }
warn()  { echo "⚠ $*"; }
fail()  { echo "✗ $*" >&2; exit 1; }

check_redis() {
  if redis-cli ping &>/dev/null 2>&1; then
    ok "Redis is reachable"
    return 0
  fi
  # Try kubectl port-forward check
  if kubectl exec redis-0 -- redis-cli ping &>/dev/null 2>&1; then
    ok "Redis reachable via kubectl"
    return 0
  fi
  fail "Redis not reachable. Start Redis first (docker run -d -p 6379:6379 redis:7)"
}

check_pi() {
  command -v pi &>/dev/null || fail "pi coding agent not found in PATH"
  [ -d "${HOME}/.pi/agent" ] || fail "pi agent directory not found at ~/.pi/agent"
  ok "pi coding agent found"
}

# ── Tier Selection ───────────────────────────────────────
if [ -z "$TIER" ]; then
  echo ""
  echo "╔═══════════════════════════════════════════════════╗"
  echo "║  Agent Gateway Setup                              ║"
  echo "╠═══════════════════════════════════════════════════╣"
  echo "║  1. Notification bridge     — events → pi session ║"
  echo "║  2. Always-on + heartbeat   — tmux/launchd        ║"
  echo "║  3. Multi-session routing   — central + satellite  ║"
  echo "╚═══════════════════════════════════════════════════╝"
  echo ""
  read -rp "Choose tier [1-3]: " TIER
fi

case "$TIER" in
  --tier) TIER="$2"; shift 2 ;;
esac

# ── Preflight ────────────────────────────────────────────
info "Checking prerequisites..."
check_redis
check_pi

# ── Install Extension ────────────────────────────────────
if [ -f "$PI_EXT_DIR/index.ts" ]; then
  info "Gateway extension already exists at $PI_EXT_DIR"
  read -rp "Overwrite? [y/N]: " overwrite
  [[ "$overwrite" =~ ^[yY]$ ]] || { info "Keeping existing extension"; }
fi

mkdir -p "$PI_EXT_DIR"

# Package.json
cat > "$PI_EXT_DIR/package.json" << 'JSON'
{
  "name": "gateway-extension",
  "private": true,
  "dependencies": {
    "ioredis": "^5.4.2"
  }
}
JSON

info "Installing extension dependencies..."
cd "$PI_EXT_DIR" && npm install --silent 2>/dev/null
ok "Dependencies installed"

# ── Generate Extension Based on Tier ─────────────────────
case "$TIER" in
  1)
    info "Tier 1: Notification bridge"
    ROLE_CONFIG='const ROLE = "main";
const SESSION_ID = "main";'
    WATCHDOG_CODE=""
    BOOT_CODE=""
    ;;
  2)
    info "Tier 2: Always-on with heartbeat"
    ROLE_CONFIG='const ROLE = "central";
const SESSION_ID = "gateway";'
    WATCHDOG_CODE='
// ── Watchdog ────────────────────────────────────────────
const WATCHDOG_THRESHOLD_MS = 30 * 60 * 1000;
let lastHeartbeatTs = Date.now();
let watchdogAlarmFired = false;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;

function startWatchdog(pi: any, ctx: any) {
  watchdogTimer = setInterval(() => {
    if (watchdogAlarmFired) return;
    const elapsed = Date.now() - lastHeartbeatTs;
    if (elapsed > WATCHDOG_THRESHOLD_MS) {
      watchdogAlarmFired = true;
      const mins = Math.round(elapsed / 60000);
      pi.sendUserMessage(`## ⚠️ MISSED HEARTBEAT\n\nNo heartbeat in **${mins} minutes**.\n\n### Triage\n1. Check your worker process\n2. Check Redis connectivity\n3. Check Inngest server`);
    }
  }, 5 * 60 * 1000);
}'
    BOOT_CODE='
    // Boot prompt
    setTimeout(() => {
      piRef!.sendUserMessage("## Gateway Boot\n\nCentral gateway session started. Monitoring heartbeats and system events.");
    }, 2000);'
    ;;
  3)
    info "Tier 3: Multi-session routing"
    ROLE_CONFIG='const ROLE = process.env.GATEWAY_ROLE ?? "satellite";
const SESSION_ID = ROLE === "central" ? "gateway" : `pid-${process.pid}`;'
    WATCHDOG_CODE='
const WATCHDOG_THRESHOLD_MS = 30 * 60 * 1000;
let lastHeartbeatTs = Date.now();
let watchdogAlarmFired = false;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;

function startWatchdog(pi: any, ctx: any) {
  if (ROLE !== "central") return;
  watchdogTimer = setInterval(() => {
    if (watchdogAlarmFired) return;
    const elapsed = Date.now() - lastHeartbeatTs;
    if (elapsed > WATCHDOG_THRESHOLD_MS) {
      watchdogAlarmFired = true;
      const mins = Math.round(elapsed / 60000);
      pi.sendUserMessage(`## ⚠️ MISSED HEARTBEAT\n\nNo heartbeat in **${mins} minutes**.\n\n### Triage\n1. Check your worker process\n2. Check Redis connectivity\n3. Check Inngest server`);
    }
  }, 5 * 60 * 1000);
}'
    BOOT_CODE='
    if (ROLE === "central") {
      setTimeout(() => {
        piRef!.sendUserMessage(`## Gateway Boot — Central\n\nSession: \`${SESSION_ID}\`\nRole: **${ROLE}**\n\nMonitoring heartbeats and system events.`);
      }, 2000);
    }'
    ;;
  *)
    fail "Invalid tier: $TIER"
    ;;
esac

cat > "$PI_EXT_DIR/index.ts" << EXTENSION
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import Redis from "ioredis";

${ROLE_CONFIG}
const SESSIONS_SET = "agent:gateway:sessions";
const EVENT_LIST = \`agent:events:\${SESSION_ID}\`;
const NOTIFY_CHANNEL = \`agent:notify:\${SESSION_ID}\`;

let sub: Redis | null = null;
let cmd: Redis | null = null;
let ctx: ExtensionContext | null = null;
let piRef: ExtensionAPI | null = null;
const seenIds = new Set<string>();

interface SystemEvent { id: string; type: string; source: string; payload: Record<string, unknown>; ts: number; }
${WATCHDOG_CODE}

function formatEvents(events: SystemEvent[]): string {
  return events.map(e => {
    const time = new Date(e.ts).toLocaleTimeString("en-US", { hour12: false });
    return \`- **[\${time}] \${e.type}** (\${e.source})\`;
  }).join("\\n");
}

async function drain(): Promise<void> {
  if (!cmd || !piRef) return;
  const raw = await cmd.lrange(EVENT_LIST, 0, -1);
  if (raw.length === 0) return;

  const events: SystemEvent[] = [];
  for (const item of raw.reverse()) {
    try {
      const evt = JSON.parse(item) as SystemEvent;
      if (seenIds.has(evt.id)) continue;
      seenIds.add(evt.id);
      events.push(evt);
    } catch {}
  }

  if (events.length === 0) { await cmd.del(EVENT_LIST); return; }

  // Track heartbeats for watchdog
  if (events.some(e => e.type === "cron.heartbeat")) {
    if (typeof lastHeartbeatTs !== "undefined") {
      lastHeartbeatTs = Date.now();
      watchdogAlarmFired = false;
    }
  }

  const prompt = [
    \`## 🔔 \${events.length} event(s) — \${new Date().toISOString()}\`,
    "", formatEvents(events), "",
    "Take action if needed, otherwise acknowledge briefly.",
  ].join("\\n");

  if (ctx?.isIdle()) {
    piRef.sendUserMessage(prompt);
  } else {
    piRef.sendUserMessage(prompt, { deliverAs: "followUp" });
  }
  await cmd.del(EVENT_LIST);

  // Trim dedup set
  if (seenIds.size > 500) {
    const arr = Array.from(seenIds);
    for (let i = 0; i < arr.length - 500; i++) seenIds.delete(arr[i]);
  }
}

export default function (pi: ExtensionAPI) {
  piRef = pi;

  pi.on("session_start", async (_event, _ctx) => {
    ctx = _ctx;
    sub = new Redis({ host: "localhost", port: 6379, lazyConnect: true, retryStrategy: (t: number) => Math.min(t * 500, 30000) });
    cmd = new Redis({ host: "localhost", port: 6379, lazyConnect: true, retryStrategy: (t: number) => Math.min(t * 500, 30000) });
    sub.on("error", () => {});
    cmd.on("error", () => {});
    await sub.connect();
    await cmd.connect();

    await cmd.sadd(SESSIONS_SET, SESSION_ID);
    await sub.subscribe(NOTIFY_CHANNEL);
    sub.on("message", () => { if (ctx?.isIdle()) drain(); });

    ctx.ui.setStatus("gateway", \`🔗 \${SESSION_ID}\`);
    ${BOOT_CODE}

    if (typeof startWatchdog === "function") startWatchdog(pi, ctx);

    const pending = await cmd.llen(EVENT_LIST);
    if (pending > 0) await drain();
  });

  pi.on("agent_end", async () => { drain(); });

  pi.on("session_shutdown", async () => {
    if (typeof watchdogTimer !== "undefined" && watchdogTimer) clearInterval(watchdogTimer);
    try {
      if (cmd) { await cmd.srem(SESSIONS_SET, SESSION_ID); await cmd.del(EVENT_LIST); }
      if (sub) { sub.unsubscribe(); sub.disconnect(); }
      if (cmd) { cmd.disconnect(); }
    } catch {}
  });

  pi.registerCommand("gateway-status", {
    description: "Show gateway session info",
    handler: async (_args, _ctx) => {
      _ctx.ui.notify(\`Session: \${SESSION_ID}\\nRole: \${ROLE}\\nList: \${EVENT_LIST}\`, "info");
    },
  });
}
EXTENSION

ok "Extension written to $PI_EXT_DIR/index.ts"

# ── Tier 2+: tmux/launchd setup ─────────────────────────
if [ "$TIER" -ge 2 ]; then
  info "Setting up persistence..."
  
  if command -v tmux &>/dev/null; then
    ok "tmux found"
    echo ""
    echo "To start the always-on session:"
    echo "  tmux new-session -d -s gateway -x 120 -y 40 'GATEWAY_ROLE=central pi'"
    echo ""
    echo "To attach:   tmux attach -t gateway"
    echo "To detach:   Ctrl-B, D"
  else
    warn "tmux not found. Install: brew install tmux"
  fi

  echo ""
  echo "For launchd (auto-start on boot), create:"
  echo "  ~/Library/LaunchAgents/com.you.agent-gateway.plist"
  echo "See the gateway-setup skill for the full plist template."
fi

# ── Tier 3: multi-session instructions ───────────────────
if [ "$TIER" -ge 3 ]; then
  echo ""
  info "Multi-session routing enabled."
  echo "  Central:    GATEWAY_ROLE=central pi"
  echo "  Satellite:  pi  (auto-registers as pid-based)"
  echo ""
  echo "Central gets all events. Satellites get only events they started."
fi

# ── Done ─────────────────────────────────────────────────
echo ""
ok "Gateway setup complete (Tier $TIER)"
echo ""
echo "Restart pi to load the extension."
echo "You should see 🔗 in the status bar."
echo ""
echo "Test: redis-cli LPUSH agent:events:${SESSION_ID} '{\"id\":\"test\",\"type\":\"test\",\"source\":\"setup-script\",\"payload\":{},\"ts\":'$(date +%s000)'}'"
echo "      redis-cli PUBLISH agent:notify:${SESSION_ID} test"
