#!/bin/sh
set -eu

REPO_ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/.joelclaw/logs"
mkdir -p "$LAUNCH_AGENTS" "$LOG_DIR"

write_plist() {
  label="$1"
  interval="$2"
  command="$3"
  xml_command="$(printf '%s' "$command" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g')"
  plist="$LAUNCH_AGENTS/$label.plist"
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string><string>-lc</string><string>$xml_command</string>
  </array>
  <key>StartInterval</key><integer>$interval</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/$label.out.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/$label.err.log</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
EOF
  plutil -lint "$plist" >/dev/null
  launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  launchctl kickstart "gui/$(id -u)/$label"
  echo "installed $label every ${interval}s"
}

write_plist "com.joelclaw.critical-search-replicate" 60 \
  "cd '$REPO_ROOT' && ./scripts/replicate-critical-db.sh"
write_plist "com.joelclaw.critical-search-synthetic" 120 \
  "cd '$REPO_ROOT' && bun ./scripts/check-critical-search-replicas.ts"
