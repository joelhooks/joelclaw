#!/usr/bin/env bash
# Restate Lab — Setup
# Sets up port-forwards and registers the worker with Restate.
#
# Run this once before testing. It:
#   1. Port-forwards Restate admin (9070) and ingress (8080)
#   2. Cleans stale deployments
#   3. Registers the lab worker

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LAB_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LAB_PORT="${LAB_PORT:-9090}"
RESTATE_ADMIN="http://localhost:9070"
RESTATE_INGRESS="http://localhost:8080"

echo "🔧 Restate Lab Setup"
echo ""

# 1. Port-forwards
echo "📡 Setting up port-forwards..."
# Kill any existing port-forwards for these ports
pkill -f "port-forward.*svc/restate.*8080" 2>/dev/null || true
pkill -f "port-forward.*svc/restate.*9070" 2>/dev/null || true
sleep 1

kubectl port-forward -n joelclaw svc/restate 8080:8080 &>/dev/null &
PF_INGRESS_PID=$!
kubectl port-forward -n joelclaw svc/restate 9070:9070 &>/dev/null &
PF_ADMIN_PID=$!
sleep 2

# Verify
if ! curl -sf "$RESTATE_ADMIN/health" >/dev/null 2>&1; then
  echo "❌ Restate admin not reachable on $RESTATE_ADMIN"
  exit 1
fi
echo "   ✅ Admin: $RESTATE_ADMIN (PID: $PF_ADMIN_PID)"
echo "   ✅ Ingress: $RESTATE_INGRESS (PID: $PF_INGRESS_PID)"

# 2. Clean stale deployments
echo ""
echo "🧹 Cleaning stale deployments..."
DEPLOYMENTS=$(curl -sf "$RESTATE_ADMIN/deployments" | jq -r '.deployments[].id')
for dep_id in $DEPLOYMENTS; do
  echo "   Removing $dep_id..."
  curl -sf -X DELETE "$RESTATE_ADMIN/deployments/$dep_id?force=true" >/dev/null
done
echo "   ✅ Cleaned $(echo "$DEPLOYMENTS" | wc -w | tr -d ' ') stale deployments"

# 3. Register lab worker
echo ""
echo "📋 Registering lab worker at http://host.lima.internal:${LAB_PORT}..."
REGISTER_RESULT=$(curl -sf -X POST "$RESTATE_ADMIN/deployments" \
  -H "Content-Type: application/json" \
  -d "{\"uri\": \"http://host.lima.internal:${LAB_PORT}\", \"force\": true}")

SERVICES=$(echo "$REGISTER_RESULT" | jq -r '.services[].name' 2>/dev/null)
echo "   ✅ Registered services: $SERVICES"

echo ""
echo "🚀 Ready! Run these in separate terminals:"
echo "   Terminal 1: cd $LAB_DIR && bun run lab"
echo "   Terminal 2: cd $LAB_DIR && bun run send"
echo ""
echo "   Kill test: Ctrl+C the worker after step 2-3, then restart it."
echo "   Port-forward PIDs: ingress=$PF_INGRESS_PID admin=$PF_ADMIN_PID"
echo "   Kill port-forwards: kill $PF_INGRESS_PID $PF_ADMIN_PID"
