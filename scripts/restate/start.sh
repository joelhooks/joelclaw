#!/bin/bash
set -euo pipefail

export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="${HOME}/.config/system-bus.env"

cd "$REPO_ROOT"
mkdir -p /tmp/joelclaw

if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a
  . "$ENV_FILE"
  set +a
fi

export RESTATE_PORT="${RESTATE_PORT:-9080}"

if [ "${CHANNEL:-}" = "console" ]; then
  echo "[restate-worker] CHANNEL=console is not headless-safe; forcing CHANNEL=noop" >&2
  export CHANNEL=noop
elif [ -z "${CHANNEL:-}" ] && { [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_USER_ID:-}" ]; }; then
  export CHANNEL=noop
fi

cleanup_stale_port() {
  local stale_pid=""
  stale_pid="$(/usr/sbin/lsof -ti :"$RESTATE_PORT" 2>/dev/null | head -1 || true)"
  if [ -z "$stale_pid" ]; then
    return 0
  fi

  echo "[restate-worker] killing stale pid $stale_pid on port $RESTATE_PORT" >&2
  kill -TERM "$stale_pid" 2>/dev/null || true
  for _ in 1 2 3 4 5; do
    /bin/sleep 1
    if ! kill -0 "$stale_pid" 2>/dev/null; then
      stale_pid=""
      break
    fi
  done

  if [ -n "$stale_pid" ] && kill -0 "$stale_pid" 2>/dev/null; then
    echo "[restate-worker] force killing stale pid $stale_pid on port $RESTATE_PORT" >&2
    kill -KILL "$stale_pid" 2>/dev/null || true
  fi
}

register_deployment() {
  if [ "${RESTATE_REGISTER_ON_START:-1}" != "1" ]; then
    return 0
  fi

  if ! command -v restate >/dev/null 2>&1; then
    echo "[restate-worker] restate CLI missing; skipping deployment register" >&2
    return 0
  fi

  local admin_health_url
  admin_health_url="${RESTATE_ADMIN_URL:-http://localhost:9070}/health"
  if ! /usr/bin/curl -fsS --max-time 5 "$admin_health_url" >/dev/null 2>&1; then
    echo "[restate-worker] admin API unavailable at $admin_health_url; skipping deployment register" >&2
    return 0
  fi

  if ! "$REPO_ROOT/scripts/restate/register-deployment.sh"; then
    echo "[restate-worker] deployment register failed" >&2
  fi
}

cleanup() {
  if [ -n "${WORKER_PID:-}" ]; then
    echo "[restate-worker] forwarding shutdown to PID $WORKER_PID" >&2
    kill -TERM "$WORKER_PID" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      kill -0 "$WORKER_PID" 2>/dev/null || break
      /bin/sleep 1
    done
    kill -KILL "$WORKER_PID" 2>/dev/null || true
  fi
  exit 0
}
trap cleanup SIGTERM SIGINT SIGHUP

cleanup_stale_port

bun run packages/restate/src/index.ts &
WORKER_PID=$!

(
  /bin/sleep 5
  register_deployment
) &

wait "$WORKER_PID"
