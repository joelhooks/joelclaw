#!/bin/bash
set -euo pipefail

LOG_DIR="${HOME}/.local/log"
SOCKET_DIR="${HOME}/.agent-secrets"
mkdir -p "${LOG_DIR}" "${SOCKET_DIR}"

exec /Users/joel/.local/bin/secrets serve --socket "${SOCKET_DIR}/agent-secrets.sock"
