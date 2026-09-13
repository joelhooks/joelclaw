#!/bin/sh
# Fake imsg for tests. Behaviour is driven by FAKE_IMSG_MODE:
#   ok (default) - emit NDJSON fixtures per subcommand
#   denied       - mimic the Full Disk Access failure
#   crash        - non-zero exit with generic stderr
#   automation   - mimic the AppleScript Automation denial on send
#   noisy        - prefix stdout with a non-JSON line before the fixtures
#   garbage      - stdout is only non-JSON
#   hang         - sleep 30s (for kill/timeout tests)
# Every invocation appends its argv (one arg per line, NUL-free) to FAKE_IMSG_ARGS_FILE when set.
set -eu
if [ -n "${FAKE_IMSG_ARGS_FILE:-}" ]; then
  printf '%s\n' "$@" >"$FAKE_IMSG_ARGS_FILE"
fi
sub=${1:-}
case "${FAKE_IMSG_MODE:-ok}" in
  denied)
    if [ "$sub" != "--version" ]; then
      printf 'authorization denied (code: 23)\n\n⚠️  Permission Error: Cannot access Messages database\nrequires Full Disk Access permission.\n' >&2
      exit 1
    fi
    ;;
  crash)
    if [ "$sub" != "--version" ]; then
      printf 'boom: something else broke\n' >&2
      exit 3
    fi
    ;;
  automation)
    if [ "$sub" = "send" ]; then
      printf 'AppleScript error: Not permitted to send Apple events to Messages. (-1743)\n' >&2
      exit 1
    fi
    ;;
  noisy)
    if [ "$sub" != "--version" ]; then printf 'note: this is not json\n'; fi
    ;;
  garbage)
    if [ "$sub" != "--version" ]; then printf 'not json at all\nstill not json\n'; exit 0; fi
    ;;
  hang)
    if [ "$sub" != "--version" ]; then sleep 30; exit 0; fi
    ;;
esac
case "$sub" in
  --version) printf '0.15.4\n' ;;
  chats)
    printf '{"id":42,"name":"Alice","display_name":null,"contact_name":"Alice Smith","identifier":"+15551234567","guid":"iMessage;-;+15551234567","service":"iMessage","last_message_at":"2026-09-13T10:30:00Z","is_group":false,"participants":["+15551234567"],"unread_count":3}\n'
    printf '{"id":7,"name":"Crew","display_name":"Crew","identifier":"chat123","guid":"iMessage;+;chat123","service":"iMessage","last_message_at":"2026-09-12T10:30:00Z","is_group":true,"participants":["+15551234567","+15557654321"],"unread_count":0}\n'
    ;;
  group)
    printf '{"chat_id":42,"chat_identifier":"+15551234567","chat_guid":"iMessage;-;+15551234567","display_name":null,"service":"iMessage","is_group":false,"participants":["+15551234567"]}\n'
    ;;
  history)
    long=$(printf 'x%.0s' $(seq 1 4500))
    printf '{"id":1001,"chat_id":42,"guid":"g-1","sender":"+15551234567","sender_name":"Alice Smith","is_from_me":false,"text":"Hello world","created_at":"2026-09-13T10:30:00Z","attachments":[]}\n'
    printf '{"id":1002,"chat_id":42,"guid":"g-2","sender":null,"is_from_me":true,"text":"%s","created_at":"2026-09-13T10:31:00Z","attachments":[{"filename":"photo.jpg","mime_type":"image/jpeg","original_path":"/tmp/photo.jpg","total_bytes":12}]}\n' "$long"
    ;;
  send)
    printf '{"success":true,"chat_id":42,"guid":"sent-1"}\n'
    ;;
  *)
    printf 'unknown subcommand %s\n' "$sub" >&2
    exit 2
    ;;
esac
