#!/usr/bin/env bash
# Build SYSTEM.md by concatenating base prompt + identity files
# Usage: ./scripts/build-system-prompt.sh [role]
# Default role: interactive

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
JOELCLAW_DIR="$HOME/.joelclaw"
ROLE="${1:-interactive}"
ROLE_FILE="$REPO/roles/${ROLE}.md"

if [[ ! -f "$ROLE_FILE" ]]; then
  echo "Unknown role: $ROLE (no file at $ROLE_FILE)" >&2
  exit 1
fi

BASE="$REPO/SYSTEM-base.md"
OUT="$REPO/SYSTEM.md"

if [[ ! -f "$BASE" ]]; then
  echo "Missing base prompt: $BASE" >&2
  exit 1
fi

cat "$BASE" > "$OUT"

for section in IDENTITY SOUL; do
  file="$JOELCLAW_DIR/${section}.md"
  if [[ -f "$file" ]]; then
    printf '\n\n---\n\n' >> "$OUT"
    cat "$file" >> "$OUT"
  fi
done

# Role
printf '\n\n---\n\n' >> "$OUT"
cat "$ROLE_FILE" >> "$OUT"

# User
if [[ -f "$JOELCLAW_DIR/USER.md" ]]; then
  printf '\n\n---\n\n' >> "$OUT"
  cat "$JOELCLAW_DIR/USER.md" >> "$OUT"
fi

echo "Built SYSTEM.md with role=$ROLE ($(wc -l < "$OUT") lines)"
