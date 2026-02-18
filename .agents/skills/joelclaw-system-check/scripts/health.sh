#!/bin/bash
# joelclaw system health check — outputs JSON for agent consumption
set -o pipefail

RED='\033[0;31m'
YEL='\033[0;33m'
GRN='\033[0;32m'
RST='\033[0m'

TOTAL=0
COUNT=0
ISSUES=()

check() {
  local name="$1" score="$2" detail="$3"
  TOTAL=$((TOTAL + score))
  COUNT=$((COUNT + 1))
  local icon="✅"
  [[ $score -le 5 ]] && icon="⚠️"
  [[ $score -le 3 ]] && icon="❌"
  printf "%-3s %-28s %2d/10  %s\n" "$icon" "$name" "$score" "$detail"
  [[ $score -lt 7 ]] && ISSUES+=("$name ($score/10): $detail")
}

echo "═══════════════════════════════════════════════════"
echo "  joelclaw system health — $(date '+%Y-%m-%d %H:%M')"
echo "═══════════════════════════════════════════════════"
echo ""

# ── k8s cluster ──────────────────────────────────────────
K8S_PODS=$(kubectl get pods -n joelclaw --no-headers 2>/dev/null | grep -c "Running" || echo 0)
K8S_TOTAL=$(kubectl get pods -n joelclaw --no-headers 2>/dev/null | wc -l | tr -d ' ')
K8S_RESTARTS=$(kubectl get pods -n joelclaw --no-headers 2>/dev/null | awk '{sum+=$4} END {print sum+0}')
if [[ "$K8S_PODS" == "$K8S_TOTAL" && "$K8S_TOTAL" -ge 3 ]]; then
  check "k8s cluster" 10 "${K8S_PODS}/${K8S_TOTAL} pods Running, ${K8S_RESTARTS} restarts"
elif [[ "$K8S_PODS" -gt 0 ]]; then
  check "k8s cluster" 5 "${K8S_PODS}/${K8S_TOTAL} pods Running"
else
  check "k8s cluster" 1 "no pods running"
fi

# ── worker health ────────────────────────────────────────
WORKER_RESP=$(curl -sf http://localhost:3111/ 2>/dev/null || echo "")
WORKER_OK=0
[[ -n "$WORKER_RESP" ]] && WORKER_OK=1
WORKER_FUNCS=$(echo "$WORKER_RESP" | tr ',' '\n' | grep -cE "video-download|transcript-process|agent-loop|memory|content" || true)
[[ -z "$WORKER_FUNCS" || "$WORKER_FUNCS" == "0" ]] && WORKER_FUNCS=$(echo "$WORKER_RESP" | grep -oE 'Functions: [0-9]+' | grep -oE '[0-9]+' || echo 0)
if [[ "$WORKER_OK" -gt 0 && "$WORKER_FUNCS" -ge 16 ]]; then
  check "worker" 10 "${WORKER_FUNCS} functions, healthy"
elif [[ "$WORKER_OK" -gt 0 ]]; then
  check "worker" 7 "${WORKER_FUNCS} functions (expected 16+)"
else
  check "worker" 1 "worker not responding on :3111"
fi

# ── inngest server ───────────────────────────────────────
IGS_CODE=$(curl -so /dev/null -w "%{http_code}" http://localhost:8288/ 2>/dev/null || echo 0)
IGS_OK=0
[[ "$IGS_CODE" == "200" || "$IGS_CODE" == "302" || "$IGS_CODE" == "301" ]] && IGS_OK=1
if [[ "$IGS_OK" == "1" ]]; then
  check "inngest server" 10 "responding on :8288"
else
  check "inngest server" 1 "not responding on :8288"
fi

# ── redis ────────────────────────────────────────────────
REDIS_OK=$(bun -e 'import Redis from "ioredis"; const r=new Redis({host:"localhost",port:6379,lazyConnect:true}); await r.connect(); const p=await r.ping(); console.log(p); await r.quit()' 2>/dev/null | grep -c PONG || echo 0)
REDIS_MEM=$(bun -e 'import Redis from "ioredis"; const r=new Redis({host:"localhost",port:6379,lazyConnect:true}); await r.connect(); const i=await r.info("memory"); console.log(i.match(/used_memory_human:(\S+)/)?.[1]??"?"); await r.quit()' 2>/dev/null)
if [[ "$REDIS_OK" == "1" ]]; then
  check "redis" 10 "PONG, ${REDIS_MEM}"
else
  check "redis" 1 "not responding"
fi

# ── qdrant ───────────────────────────────────────────────
QDRANT_POINTS=$(curl -sf http://localhost:6333/collections/memory_observations 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('result',{}).get('points_count',0))" 2>/dev/null || echo 0)
QDRANT_VECTORS=$(curl -sf http://localhost:6333/collections/memory_observations 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('result',{}).get('vectors_count',0))" 2>/dev/null || echo 0)
if [[ "$QDRANT_POINTS" -gt 0 && "$QDRANT_VECTORS" -gt 0 ]]; then
  check "qdrant" 10 "${QDRANT_POINTS} points, ${QDRANT_VECTORS} vectors"
elif [[ "$QDRANT_POINTS" -gt 0 ]]; then
  check "qdrant" 5 "${QDRANT_POINTS} points, 0 real vectors (zero vectors)"
else
  check "qdrant" 2 "no points in memory_observations"
fi

# ── tests ────────────────────────────────────────────────
SBUS_DIR=~/Code/system-bus-worker/packages/system-bus
TEST_OUTPUT=$(cd "$SBUS_DIR" && bun test 2>&1)
TEST_PASS=$(echo "$TEST_OUTPUT" | grep -oE '[0-9]+ pass' | head -1 | grep -oE '[0-9]+' || echo 0)
TEST_FAIL=$(echo "$TEST_OUTPUT" | grep " fail" | head -1 | grep -oE '^[[:space:]]*[0-9]+' | tr -d ' ' || echo 0)
[[ -z "$TEST_FAIL" ]] && TEST_FAIL=0
if [[ "$TEST_FAIL" == "0" && "$TEST_PASS" -gt 0 ]]; then
  check "tests" 10 "${TEST_PASS} pass / ${TEST_FAIL} fail"
elif [[ "$TEST_FAIL" -gt 0 ]]; then
  check "tests" 3 "${TEST_PASS} pass / ${TEST_FAIL} fail"
else
  check "tests" 1 "tests didn't run"
fi

# ── tsc ──────────────────────────────────────────────────
TSC_OUTPUT=$(cd "$SBUS_DIR" && bunx tsc --noEmit 2>&1)
TSC_ERRORS=$(echo "$TSC_OUTPUT" | grep -c "error TS" || true)
[[ -z "$TSC_ERRORS" ]] && TSC_ERRORS=0
if [[ "$TSC_ERRORS" == "0" ]]; then
  check "tsc" 10 "clean"
else
  check "tsc" 3 "${TSC_ERRORS} type errors"
fi

# ── repo sync ────────────────────────────────────────────
WORKER_SHA=$(cd ~/Code/system-bus-worker && git rev-parse --short HEAD 2>/dev/null)
MONO_SHA=$(cd ~/Code/joelhooks/joelclaw && git rev-parse --short HEAD 2>/dev/null)
if [[ "$WORKER_SHA" == "$MONO_SHA" ]]; then
  check "repo sync" 10 "worker=monorepo ($WORKER_SHA)"
else
  BEHIND=$(cd ~/Code/system-bus-worker && git log --oneline HEAD..origin/main 2>/dev/null | wc -l | tr -d ' ')
  AHEAD=$(cd ~/Code/system-bus-worker && git log --oneline origin/main..HEAD 2>/dev/null | wc -l | tr -d ' ')
  check "repo sync" 3 "DRIFT: worker=$WORKER_SHA mono=$MONO_SHA (${AHEAD} ahead, ${BEHIND} behind)"
fi

# ── memory pipeline ──────────────────────────────────────
OBS_COUNT=$(bun -e 'import Redis from "ioredis"; const r=new Redis({host:"localhost",port:6379,lazyConnect:true}); await r.connect(); const keys=await r.keys("memory:observations:*"); let t=0; for(const k of keys) t+=await r.llen(k); console.log(t); await r.quit()' 2>/dev/null || echo 0)
OBS_DAYS=$(bun -e 'import Redis from "ioredis"; const r=new Redis({host:"localhost",port:6379,lazyConnect:true}); await r.connect(); const keys=await r.keys("memory:observations:*"); console.log(keys.length); await r.quit()' 2>/dev/null || echo 0)
PENDING=$(bun -e 'import Redis from "ioredis"; const r=new Redis({host:"localhost",port:6379,lazyConnect:true}); await r.connect(); const p=await r.llen("memory:review:pending"); console.log(p); await r.quit()' 2>/dev/null || echo 0)
if [[ "$OBS_COUNT" -gt 50 && "$OBS_DAYS" -gt 7 ]]; then
  check "memory pipeline" 10 "${OBS_COUNT} obs across ${OBS_DAYS} days, ${PENDING} pending proposals"
elif [[ "$OBS_COUNT" -gt 0 ]]; then
  check "memory pipeline" 7 "${OBS_COUNT} obs across ${OBS_DAYS} day(s), ${PENDING} pending (collecting data)"
else
  check "memory pipeline" 2 "no observations"
fi

# ── pi-tools ─────────────────────────────────────────────
PI_DEPS_OK=0
[[ -f ~/.pi/agent/git/github.com/joelhooks/pi-tools/node_modules/@sinclair/typebox/package.json ]] && PI_DEPS_OK=$((PI_DEPS_OK+1))
[[ -d ~/.pi/agent/git/github.com/joelhooks/pi-tools/node_modules/@mariozechner/pi-coding-agent ]] && PI_DEPS_OK=$((PI_DEPS_OK+1))
[[ -d ~/.pi/agent/git/github.com/joelhooks/pi-tools/node_modules/@mariozechner/pi-tui ]] && PI_DEPS_OK=$((PI_DEPS_OK+1))
if [[ "$PI_DEPS_OK" == "3" ]]; then
  check "pi-tools" 10 "all deps present"
else
  check "pi-tools" 2 "${PI_DEPS_OK}/3 deps — run: cd ~/.pi/agent/git/github.com/joelhooks/pi-tools && bun add @sinclair/typebox @mariozechner/pi-coding-agent @mariozechner/pi-tui @mariozechner/pi-ai"
fi

# ── git config ───────────────────────────────────────────
GIT_NAME=$(git config --global user.name 2>/dev/null)
GIT_EMAIL=$(git config --global user.email 2>/dev/null)
if [[ -n "$GIT_NAME" && -n "$GIT_EMAIL" ]]; then
  check "git config" 10 "${GIT_NAME} <${GIT_EMAIL}>"
else
  check "git config" 2 "missing — run: git config --global user.name 'Joel Hooks' && git config --global user.email 'joelhooks@gmail.com'"
fi

# ── active loops ─────────────────────────────────────────
LOOP_COUNT=$(cd ~/Code/joelhooks/igs && bun run src/cli.ts loop list 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(len([l for l in d['result']['loops'] if l['status']=='active']))" 2>/dev/null || echo "?")
check "active loops" 10 "${LOOP_COUNT} active"

# ── disk ─────────────────────────────────────────────────
DISK_FREE=$(df -h / | tail -1 | awk '{print $4}')
DISK_PCT=$(df -h / | tail -1 | awk '{gsub(/%/,"",$5); print $5}')
LOOP_TMP=$(du -sm /tmp/agent-loop/ 2>/dev/null | awk '{print $1}' || echo 0)
if [[ "$DISK_PCT" -lt 80 ]]; then
  DISK_SCORE=10
  [[ "$LOOP_TMP" -gt 2000 ]] && DISK_SCORE=8
  check "disk" $DISK_SCORE "${DISK_FREE} free (${DISK_PCT}% used), loop tmp: ${LOOP_TMP}MB"
else
  check "disk" 4 "${DISK_FREE} free (${DISK_PCT}% used) — low"
fi

# ── gogcli (Google Workspace) ────────────────────────────
GOG_KP=$(secrets lease gog_keyring_password --raw 2>/dev/null || echo "")
if [[ -n "$GOG_KP" ]]; then
  GOG_LIST=$(GOG_KEYRING_PASSWORD="$GOG_KP" gog auth list --check 2>&1)
  GOG_ACCT=$(echo "$GOG_LIST" | grep -c "true" || echo 0)
  GOG_SVCS=$(echo "$GOG_LIST" | head -1 | awk -F'\t' '{print $3}' || echo "")
  if [[ "$GOG_ACCT" -gt 0 ]]; then
    check "gogcli" 10 "${GOG_ACCT} account(s) authed, services: ${GOG_SVCS}"
  else
    check "gogcli" 3 "auth present but token check failed"
  fi
else
  GOG_LIST=$(gog auth list 2>&1)
  if echo "$GOG_LIST" | grep -q "@"; then
    check "gogcli" 5 "tokens stored but GOG_KEYRING_PASSWORD not available"
  else
    check "gogcli" 1 "not configured — run: gog auth add <email>"
  fi
fi

# ── stale tests ──────────────────────────────────────────
STALE_TESTS=$(find ~/Code/joelhooks/joelclaw/packages/system-bus -name "__tests__" -type d 2>/dev/null | head -1)
STALE_ACC=$(find ~/Code/joelhooks/joelclaw/packages/system-bus/src -name "*.acceptance.test.ts" 2>/dev/null | wc -l | tr -d ' ')
if [[ -z "$STALE_TESTS" && "$STALE_ACC" == "0" ]]; then
  check "stale tests" 10 "clean"
else
  S=""
  [[ -n "$STALE_TESTS" ]] && S="__tests__/ exists"
  [[ "$STALE_ACC" -gt 0 ]] && S="${S:+$S, }${STALE_ACC} acceptance tests"
  check "stale tests" 4 "$S — delete after verifying real tests pass"
fi

# ── summary ──────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════"
SCORE=$(( (TOTAL * 10) / (COUNT * 10) ))
# More precise with bc if available
PRECISE=$(echo "scale=1; $TOTAL / $COUNT" | bc 2>/dev/null || echo "$SCORE")
printf "  OVERALL: %s/10  (%d checks)\n" "$PRECISE" "$COUNT"
echo "═══════════════════════════════════════════════════"

if [[ ${#ISSUES[@]} -gt 0 ]]; then
  echo ""
  echo "Issues:"
  for issue in "${ISSUES[@]}"; do
    echo "  ⚠️  $issue"
  done
fi

echo ""
echo "Run: ~/.pi/agent/skills/joelclaw-system-check/scripts/health.sh"
