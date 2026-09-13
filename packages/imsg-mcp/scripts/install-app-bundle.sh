#!/bin/sh
# Create /Applications/imsg-mcp.app: a signed, pinned copy of node that launchd runs as
# the imsg-mcp main executable. macOS attributes Full Disk Access to the launchd job's
# main executable, so this copy is the narrow FDA target; the imsg child inherits it.
# Idempotent: rerunning replaces the node copy and re-signs.
# The hardened runtime needs the JIT entitlements in imsg-mcp.entitlements, otherwise V8
# aborts at startup ("Failed to reserve virtual memory for CodeRange").
set -eu

app="/Applications/imsg-mcp.app"
contents="$app/Contents"
macos="$contents/MacOS"
exe="$macos/node"
identity="${IMSG_MCP_SIGN_IDENTITY:-Developer ID Application: Joel Hooks (N7L54A44YX)}"
team_id="${IMSG_MCP_TEAM_ID:-N7L54A44YX}"
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
entitlements="$script_dir/imsg-mcp.entitlements"
test -f "$entitlements" || { printf 'missing entitlements file: %s\n' "$entitlements" >&2; exit 1; }

if [ -n "${NODE_BIN:-}" ]; then
  node_src="$NODE_BIN"
else
  node_cmd=$(command -v node) || { printf 'node not found on PATH; set NODE_BIN\n' >&2; exit 1; }
  node_src=$(readlink -f "$node_cmd")
fi
test -x "$node_src" || { printf 'node binary not executable: %s\n' "$node_src" >&2; exit 1; }
node_version=$("$node_src" --version | sed 's/^v//')

mkdir -p "$macos"
stage="$exe.new.$$"
trap 'rm -f "$stage"' EXIT
cp "$node_src" "$stage"
chmod 755 "$stage"
mv -f "$stage" "$exe"
# Drop leftovers (codesign *.cstemp, old staged copies) so only node gets sealed.
find "$macos" -type f ! -name node -exec rm -f {} +

cat >"$contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>com.joel.imsg-mcp</string>
  <key>CFBundleName</key><string>imsg-mcp</string>
  <key>CFBundleExecutable</key><string>node</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$node_version</string>
  <key>CFBundleVersion</key><string>$node_version</string>
  <key>LSUIElement</key><true/>
  <key>NSAppleEventsUsageDescription</key><string>imsg-mcp sends iMessages through Messages.app</string>
</dict>
</plist>
PLIST
plutil -lint "$contents/Info.plist" >/dev/null

codesign --force --options runtime --entitlements "$entitlements" --sign "$identity" "$app"
codesign --verify --strict --verbose "$app"

signed_team=$(codesign -dv "$app" 2>&1 | sed -n 's/^TeamIdentifier=//p')
if [ "$signed_team" != "$team_id" ]; then
  printf 'codesign TeamIdentifier is %s, expected %s\n' "${signed_team:-<none>}" "$team_id" >&2
  exit 1
fi
if ! codesign -d --entitlements - "$app" 2>/dev/null | grep -q 'com.apple.security.cs.allow-jit'; then
  printf 'signed bundle is missing the allow-jit entitlement\n' >&2
  exit 1
fi

printf '%s\n' "$exe"
