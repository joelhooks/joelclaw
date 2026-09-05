#!/usr/bin/env bun

import { replayNativeRunCaptureOutboxes } from "../packages/flowing-memory-host/src/raw-capture"

if (!process.argv.includes("--apply")) {
  console.log(
    JSON.stringify({
      ok: true,
      mode: "dry-run",
      action: "memory.native_capture.outbox_replay",
    }),
  )
} else {
  await replayNativeRunCaptureOutboxes()
    .then((receipt) => {
      console.log(
        JSON.stringify({
          ok: receipt.failed === 0 && receipt.invalid === 0,
          mode: "apply",
          action: "memory.native_capture.outbox_replay",
          ...receipt,
        }),
      )
      if (receipt.failed > 0 || receipt.invalid > 0) process.exitCode = 1
    })
    .catch(() => {
      console.error(
        JSON.stringify({
          ok: false,
          action: "memory.native_capture.outbox_replay",
          error: "replay-failed",
        }),
      )
      process.exitCode = 1
    })
}
