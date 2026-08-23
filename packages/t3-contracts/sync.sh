#!/usr/bin/env bash
# Re-vendor @t3tools/contracts from a local t3code checkout.
# Usage: ./sync.sh [path-to-t3code-checkout]
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
src_repo="${1:-$HOME/Code/pingdotgg/t3code}"
src="$src_repo/packages/contracts/src"

[ -d "$src" ] || { echo "contracts source not found at $src" >&2; exit 1; }

rm -rf "$here/vendor"
mkdir -p "$here/vendor"
# Runtime sources only — tests import vite-plus/@effect/vitest which we do not carry.
find "$src" -maxdepth 1 -name '*.ts' ! -name '*.test.ts' -exec cp {} "$here/vendor/" \;

commit="$(git -C "$src_repo" rev-parse HEAD)"
version="$(node -p "require('$src_repo/packages/contracts/package.json').version")"
cat > "$here/VENDOR.json" <<EOF
{
  "source": "github.com/t3dotgg (t3code) packages/contracts",
  "version": "$version",
  "commit": "$commit",
  "syncedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
echo "vendored contracts $version @ $commit"
