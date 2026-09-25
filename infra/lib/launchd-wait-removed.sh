#!/bin/bash
# Sourced by installers. bootout acknowledges before teardown finishes.
launchd_wait_removed() {
  local target="$1" output rc attempt
  for ((attempt=0; attempt<150; attempt++)); do
    if output=$(launchctl print "$target" 2>&1); then
      sleep 0.1
    else
      rc=$?
      if [[ $rc -eq 113 && "$output" == *'Could not find service'* ]]; then
        return 0
      fi
      printf 'Cannot verify removal of %s (exit %s): %s\n' "$target" "$rc" "$output" >&2
      return 1
    fi
  done
  printf 'Service removal did not complete within 15 seconds: %s\n' "$target" >&2
  return 1
}
