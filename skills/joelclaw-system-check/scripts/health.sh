#!/bin/bash
# joelclaw system health check — outputs concise machine-friendly summary for agents
set -o pipefail

TOTAL=0
COUNT=0
ISSUES=()

REPO_DIR="${HOME}/Code/joelhooks/joelclaw"
SBUS_DIR="${REPO_DIR}/packages/system-bus"

check() {
  local name="$1" score="$2" detail="$3"
  TOTAL=$((TOTAL + score))
  COUNT=$((COUNT + 1))

  local icon="OK"
  [[ $score -le 5 ]] && icon="WARN"
  [[ $score -le 3 ]] && icon="FAIL"

  printf "%-5s %-28s %2d/10  %s\n" "$icon" "$name" "$score" "$detail"
  [[ $score -lt 7 ]] && ISSUES+=("$name ($score/10): $detail")
}

json_get() {
  local json="$1"
  local expr="$2"
  echo "$json" | jq -r "$expr" 2>/dev/null
}

echo "===================================================="
echo "  joelclaw system health -- $(date '+%Y-%m-%d %H:%M')"
echo "===================================================="
echo ""

# -- status snapshot ---------------------------------------------------
STATUS_JSON=$(joelclaw status --json 2>/dev/null || true)
STATUS_OK=$(json_get "$STATUS_JSON" '.ok // false')

# -- k8s cluster -------------------------------------------------------
if [[ "$STATUS_OK" == "true" ]]; then
  K8S_OK=$(json_get "$STATUS_JSON" '.result.k8s.ok // false')
  K8S_DETAIL=$(json_get "$STATUS_JSON" '.result.k8s.detail // "k8s detail unavailable"')
  if [[ "$K8S_OK" == "true" ]]; then
    check "k8s cluster" 10 "$K8S_DETAIL"
  else
    check "k8s cluster" 4 "$K8S_DETAIL"
  fi
else
  check "k8s cluster" 1 "joelclaw status unavailable"
fi

# -- pds health --------------------------------------------------------
PDS_VER=$(curl -sf http://localhost:2583/xrpc/_health 2>/dev/null | jq -r '.version // empty' 2>/dev/null)
if [[ -n "$PDS_VER" ]]; then
  PDS_COLLS=$(curl -sf "http://localhost:2583/xrpc/com.atproto.repo.describeRepo?repo=did:plc:7vyfh3gnwfjniddpp5sws4mq" 2>/dev/null | jq -r '.collections | length // 0' 2>/dev/null)
  check "pds" 10 "v${PDS_VER}, ${PDS_COLLS} collections"
else
  PDS_POD=$(kubectl get pods -n joelclaw --no-headers 2>/dev/null | awk '/bluesky-pds/ && /Running/ {c++} END {print c+0}')
  if [[ "$PDS_POD" -gt 0 ]]; then
    check "pds" 4 "pod running but :2583 unreachable -- run: kubectl port-forward -n joelclaw svc/bluesky-pds 2583:3000 &"
  else
    check "pds" 1 "pod not running -- run: kubectl rollout restart deployment/bluesky-pds -n joelclaw"
  fi
fi

# -- worker health -----------------------------------------------------
INNGEST_STATUS_JSON=$(joelclaw inngest status --json 2>/dev/null || true)
INNGEST_OK=$(json_get "$INNGEST_STATUS_JSON" '.ok // false')
if [[ "$INNGEST_OK" == "true" ]]; then
  WORKER_REACHABLE=$(json_get "$INNGEST_STATUS_JSON" '.result.worker.reachable // false')
  WORKER_FN_COUNT=$(json_get "$INNGEST_STATUS_JSON" '.result.worker.functionCount // 0')
  WORKER_ROLE=$(json_get "$INNGEST_STATUS_JSON" '.result.worker.role // "unknown"')
  if [[ "$WORKER_REACHABLE" == "true" && "$WORKER_FN_COUNT" -ge 55 ]]; then
    check "worker" 10 "${WORKER_FN_COUNT} functions, role=${WORKER_ROLE}"
  elif [[ "$WORKER_REACHABLE" == "true" ]]; then
    check "worker" 7 "reachable, ${WORKER_FN_COUNT} functions"
  else
    check "worker" 1 "worker not reachable"
  fi
else
  check "worker" 1 "joelclaw inngest status unavailable"
fi

# -- inngest server ----------------------------------------------------
if [[ "$STATUS_OK" == "true" ]]; then
  SERVER_OK=$(json_get "$STATUS_JSON" '.result.server.ok // false')
  if [[ "$SERVER_OK" == "true" ]]; then
    check "inngest server" 10 "responding on :8288"
  else
    SERVER_DETAIL=$(json_get "$STATUS_JSON" '.result.server.detail // "unreachable"')
    check "inngest server" 1 "$SERVER_DETAIL"
  fi
else
  check "inngest server" 1 "status check unavailable"
fi

# -- redis / gateway ---------------------------------------------------
GW_JSON=$(joelclaw gateway status --json 2>/dev/null || true)
GW_OK=$(json_get "$GW_JSON" '.ok // false')
if [[ "$GW_OK" == "true" ]]; then
  REDIS_STATE=$(json_get "$GW_JSON" '.result.redis // "error"')
  SESSION_COUNT=$(json_get "$GW_JSON" '.result.activeSessions | length // 0')
  PENDING_TOTAL=$(echo "$GW_JSON" | jq '[.result.activeSessions[]?.pending // 0] | add // 0' 2>/dev/null)
  if [[ "$REDIS_STATE" == "connected" ]]; then
    if [[ "$PENDING_TOTAL" -gt 25 ]]; then
      check "redis/gateway" 7 "redis=${REDIS_STATE}, sessions=${SESSION_COUNT}, pending=${PENDING_TOTAL}"
    else
      check "redis/gateway" 10 "redis=${REDIS_STATE}, sessions=${SESSION_COUNT}, pending=${PENDING_TOTAL}"
    fi
  else
    check "redis/gateway" 2 "redis=${REDIS_STATE}"
  fi
else
  check "redis/gateway" 1 "joelclaw gateway status unavailable"
fi

# -- typesense / otel --------------------------------------------------
TS_HEALTH=$(curl -sf http://localhost:8108/health 2>/dev/null | jq -r '.ok // false' 2>/dev/null)
OTEL_JSON=$(joelclaw otel stats --hours 1 --json 2>/dev/null || true)
OTEL_OK=$(json_get "$OTEL_JSON" '.ok // false')
if [[ "$TS_HEALTH" == "true" && "$OTEL_OK" == "true" ]]; then
  OTEL_TOTAL=$(json_get "$OTEL_JSON" '.result.total // 0')
  OTEL_ERRORS=$(json_get "$OTEL_JSON" '.result.errors // 0')
  OTEL_RATE=$(json_get "$OTEL_JSON" '.result.errorRate // 0')
  check "typesense/otel" 10 "typesense=ok, events=${OTEL_TOTAL}, errors=${OTEL_ERRORS}, rate=${OTEL_RATE}"
elif [[ "$TS_HEALTH" == "true" ]]; then
  check "typesense/otel" 6 "typesense=ok, otel query degraded"
else
  check "typesense/otel" 1 "typesense unavailable on :8108"
fi

# -- tests -------------------------------------------------------------
if [[ -d "$SBUS_DIR" ]]; then
  TEST_OUTPUT=$(cd "$SBUS_DIR" && bun test 2>&1)
  TEST_PASS=$(echo "$TEST_OUTPUT" | grep -oE '[0-9]+ pass' | head -1 | awk '{print $1}')
  TEST_FAIL=$(echo "$TEST_OUTPUT" | grep -oE '[0-9]+ fail' | head -1 | awk '{print $1}')
  [[ -z "$TEST_PASS" ]] && TEST_PASS=0
  [[ -z "$TEST_FAIL" ]] && TEST_FAIL=0

  if [[ "$TEST_FAIL" == "0" && "$TEST_PASS" -gt 0 ]]; then
    check "tests" 10 "${TEST_PASS} pass / ${TEST_FAIL} fail"
  elif [[ "$TEST_FAIL" -gt 0 ]]; then
    check "tests" 3 "${TEST_PASS} pass / ${TEST_FAIL} fail"
  else
    check "tests" 2 "tests did not report pass/fail counts"
  fi
else
  check "tests" 1 "missing ${SBUS_DIR}"
fi

# -- tsc ---------------------------------------------------------------
if [[ -d "$SBUS_DIR" ]]; then
  TSC_OUTPUT=$(cd "$SBUS_DIR" && bunx tsc --noEmit 2>&1)
  TSC_ERRORS=$(echo "$TSC_OUTPUT" | grep -c 'error TS')
  if [[ "$TSC_ERRORS" == "0" ]]; then
    check "tsc" 10 "clean"
  else
    check "tsc" 3 "${TSC_ERRORS} type errors"
  fi
else
  check "tsc" 1 "missing ${SBUS_DIR}"
fi

# -- repo sync ---------------------------------------------------------
if [[ -d "${REPO_DIR}/.git" ]]; then
  LOCAL_SHA=$(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null)
  git -C "$REPO_DIR" fetch origin main --quiet >/dev/null 2>&1 || true

  if git -C "$REPO_DIR" rev-parse --verify origin/main >/dev/null 2>&1; then
    COUNTS=$(git -C "$REPO_DIR" rev-list --left-right --count HEAD...origin/main 2>/dev/null)
    AHEAD=$(echo "$COUNTS" | awk '{print $1+0}')
    BEHIND=$(echo "$COUNTS" | awk '{print $2+0}')

    if [[ "$AHEAD" == "0" && "$BEHIND" == "0" ]]; then
      check "repo sync" 10 "HEAD=${LOCAL_SHA}, in sync with origin/main"
    elif [[ "$BEHIND" -gt 0 && "$AHEAD" == "0" ]]; then
      check "repo sync" 6 "HEAD=${LOCAL_SHA}, behind origin/main by ${BEHIND}"
    else
      check "repo sync" 7 "HEAD=${LOCAL_SHA}, ahead=${AHEAD}, behind=${BEHIND}"
    fi
  else
    check "repo sync" 5 "origin/main not available locally"
  fi
else
  check "repo sync" 1 "repo not found at ${REPO_DIR}"
fi

# -- memory pipeline ---------------------------------------------------
MEM_JSON=$(joelclaw inngest memory-health --hours 24 --json 2>/dev/null || true)
MEM_PARSE_OK=$(echo "$MEM_JSON" | jq -r 'if (.result | type) == "object" then "true" else "false" end' 2>/dev/null)
if [[ "$MEM_PARSE_OK" == "true" ]]; then
  MEM_HEALTH_OK=$(json_get "$MEM_JSON" '.result.ok // false')
  MEM_COUNT=$(json_get "$MEM_JSON" '.result.memory.count // 0')
  MEM_FAILED=$(json_get "$MEM_JSON" '.result.runs.failedMemoryRuns // 0')
  MEM_ACTIVE=$(json_get "$MEM_JSON" '.result.runs.activeMemoryRuns // 0')
  if [[ "$MEM_HEALTH_OK" == "true" ]]; then
    check "memory pipeline" 10 "count=${MEM_COUNT}, failed=${MEM_FAILED}, active=${MEM_ACTIVE}"
  else
    check "memory pipeline" 4 "degraded: count=${MEM_COUNT}, failed=${MEM_FAILED}, active=${MEM_ACTIVE}"
  fi
else
  check "memory pipeline" 2 "joelclaw inngest memory-health unavailable"
fi

# -- pi-tools ----------------------------------------------------------
PI_DEPS_OK=0
[[ -f ~/.pi/agent/git/github.com/joelhooks/pi-tools/node_modules/@sinclair/typebox/package.json ]] && PI_DEPS_OK=$((PI_DEPS_OK + 1))
[[ -d ~/.pi/agent/git/github.com/joelhooks/pi-tools/node_modules/@mariozechner/pi-coding-agent ]] && PI_DEPS_OK=$((PI_DEPS_OK + 1))
[[ -d ~/.pi/agent/git/github.com/joelhooks/pi-tools/node_modules/@mariozechner/pi-tui ]] && PI_DEPS_OK=$((PI_DEPS_OK + 1))
if [[ "$PI_DEPS_OK" == "3" ]]; then
  check "pi-tools" 10 "all deps present"
else
  check "pi-tools" 3 "${PI_DEPS_OK}/3 deps present"
fi

# -- git config --------------------------------------------------------
GIT_NAME=$(git config --global user.name 2>/dev/null)
GIT_EMAIL=$(git config --global user.email 2>/dev/null)
if [[ -n "$GIT_NAME" && -n "$GIT_EMAIL" ]]; then
  check "git config" 10 "${GIT_NAME} <${GIT_EMAIL}>"
else
  check "git config" 2 "missing global user.name/user.email"
fi

# -- active loops ------------------------------------------------------
LOOP_JSON=$(joelclaw loop list --json 2>/dev/null || true)
LOOP_OK=$(json_get "$LOOP_JSON" '.ok // false')
if [[ "$LOOP_OK" == "true" ]]; then
  LOOP_COUNT=$(json_get "$LOOP_JSON" '.result.count // 0')
  check "active loops" 10 "${LOOP_COUNT} active"
else
  check "active loops" 4 "unable to query loop list"
fi

# -- disk --------------------------------------------------------------
DISK_FREE=$(df -h / | tail -1 | awk '{print $4}')
DISK_PCT=$(df -h / | tail -1 | awk '{gsub(/%/,"",$5); print $5}')
LOOP_TMP=$(du -sm /tmp/agent-loop/ 2>/dev/null | awk '{print $1}' || echo 0)
if [[ "$DISK_PCT" -lt 80 ]]; then
  SCORE=10
  [[ "$LOOP_TMP" -gt 2000 ]] && SCORE=8
  check "disk" "$SCORE" "${DISK_FREE} free (${DISK_PCT}% used), loop tmp=${LOOP_TMP}MB"
else
  check "disk" 4 "${DISK_FREE} free (${DISK_PCT}% used)"
fi

# -- gogcli ------------------------------------------------------------
GOG_KP=$(secrets lease gog_keyring_password --ttl 15m 2>/dev/null || echo "")
if [[ -n "$GOG_KP" ]]; then
  GOG_LIST=$(GOG_KEYRING_PASSWORD="$GOG_KP" gog auth list --check 2>&1)
  GOG_ACCT=$(echo "$GOG_LIST" | grep -c "true")
  if [[ "$GOG_ACCT" -gt 0 ]]; then
    check "gogcli" 10 "${GOG_ACCT} account(s) authed"
  else
    check "gogcli" 4 "auth configured, token check failed"
  fi
else
  GOG_LIST=$(gog auth list 2>&1)
  if echo "$GOG_LIST" | grep -q "@"; then
    check "gogcli" 5 "accounts detected but keyring password unavailable"
  else
    check "gogcli" 1 "not configured"
  fi
fi

# -- stale tests -------------------------------------------------------
STALE_TESTS=$(find "$SBUS_DIR" -name "__tests__" -type d 2>/dev/null | head -1)
STALE_ACC=$(find "$SBUS_DIR/src" -name "*.acceptance.test.ts" 2>/dev/null | wc -l | tr -d ' ')
if [[ -z "$STALE_TESTS" && "$STALE_ACC" == "0" ]]; then
  check "stale tests" 10 "clean"
else
  DETAIL=""
  [[ -n "$STALE_TESTS" ]] && DETAIL="__tests__/ exists"
  [[ "$STALE_ACC" -gt 0 ]] && DETAIL="${DETAIL:+${DETAIL}, }${STALE_ACC} acceptance tests"
  check "stale tests" 4 "${DETAIL}"
fi

# -- summary -----------------------------------------------------------
echo ""
echo "===================================================="
if [[ "$COUNT" -gt 0 ]]; then
  PRECISE=$(awk "BEGIN { printf \"%.1f\", ${TOTAL}/${COUNT} }")
else
  PRECISE="0.0"
fi
printf "  OVERALL: %s/10  (%d checks)\n" "$PRECISE" "$COUNT"
echo "===================================================="

if [[ ${#ISSUES[@]} -gt 0 ]]; then
  echo ""
  echo "Issues:"
  for issue in "${ISSUES[@]}"; do
    echo "  - $issue"
  done
fi

echo ""
echo "Run: ~/Code/joelhooks/joelclaw/skills/joelclaw-system-check/scripts/health.sh"
