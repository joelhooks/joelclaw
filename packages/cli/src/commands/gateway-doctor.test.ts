import { describe, expect, test } from "bun:test"
import {
  collectGatewayDoctor,
  detectCrashRelaunch,
  type GatewayDoctorDependencies,
  type GatewayLifecycleMarker,
  type GatewayLiveProbeReceipt,
  type GatewayRestartMarker,
} from "./gateway-doctor"

const NOW = Date.parse("2026-07-19T20:00:00.000Z")

const marker: GatewayRestartMarker = {
  status: "completed",
  requestedAt: "2026-07-19T19:54:20.000Z",
  completedAt: "2026-07-19T19:54:30.000Z",
  previousPid: "80000",
  newPid: "87618",
}

const lifecycleMarker: GatewayLifecycleMarker = {
  status: "completed",
  reason: "session-rotation:idle_session_age",
  requestedAt: "2026-07-19T19:59:50.000Z",
  completedAt: "2026-07-19T19:59:55.000Z",
  previousPid: "87618",
  newPid: "96573",
}

function healthyDependencies(overrides: Partial<GatewayDoctorDependencies> = {}): GatewayDoctorDependencies {
  return {
    now: () => NOW,
    health: async () => ({
      available: true,
      healthy: true,
      checkedAt: new Date(NOW).toISOString(),
      components: { telegram: "chat-sdk" },
      status: {
        pid: 87618,
        uptimeMs: 330_000,
        channels: {
          telegram: {
            started: true,
            companionInitialized: true,
            pollingActive: true,
            pollingState: "chat-sdk-active",
          },
        },
      },
    }),
    redisPing: async () => true,
    pid: () => "87618",
    processAlive: () => true,
    repoRoot: () => "/repo/joelclaw",
    sourceChanges: () => [],
    restartMarker: () => marker,
    ...overrides,
  }
}

describe("gateway doctor", () => {
  test("detects a crash relaunch only when a newer process differs from the operator restart", () => {
    expect(detectCrashRelaunch({
      currentPid: "87618",
      processStartAt: "2026-07-19T19:54:31.000Z",
      marker,
    })).toBe(false)

    expect(detectCrashRelaunch({
      currentPid: "96573",
      processStartAt: "2026-07-19T20:21:55.000Z",
      marker,
      lifecycleMarker: null,
    })).toBe(true)
  })

  test("accepts a daemon relaunched after a recorded graceful lifecycle restart", () => {
    expect(detectCrashRelaunch({
      currentPid: "96573",
      processStartAt: "2026-07-19T19:59:55.000Z",
      marker,
      lifecycleMarker,
    })).toBe(false)
  })

  test("prints glanceable PASS lines for process, source, and transport", async () => {
    const report = await collectGatewayDoctor({ live: false }, healthyDependencies())

    expect(report.ok).toBe(true)
    expect(report.lines).toEqual([
      "PASS daemon — pid=87618 start=2026-07-19T19:54:30.000Z uptime=0h 5m 30s crash-relaunched=no",
      "PASS source — CLEAN repo=/repo/joelclaw",
      "PASS transport — redis=PONG adapter=ready poller=active",
      "SKIP live-delivery — not requested; run joelclaw gateway doctor --live to prove Telegram delivery",
    ])
  })

  test("fails loudly when a running daemon shares dirty runtime source", async () => {
    const report = await collectGatewayDoctor(
      { live: false },
      healthyDependencies({
        sourceChanges: () => [" M packages/gateway/src/daemon.ts"],
      }),
    )

    expect(report.ok).toBe(false)
    expect(report.lines[1]).toContain("FAIL source — DIRTY")
    expect(report.warnings).toEqual([
      "DANGER: A RUNNING GATEWAY DAEMON AND DIRTY GATEWAY RUNTIME SOURCE COEXIST. A crash can relaunch half-edited code.",
    ])
    expect(report.stages[1]?.remediation).toEqual(expect.arrayContaining([
      expect.stringContaining("git -C /repo/joelclaw stash push -u"),
      "joelclaw gateway restart",
    ]))
  })

  test("--live passes only with a Telegram platform message id", async () => {
    const receipt: GatewayLiveProbeReceipt = {
      eventId: "49f89602-a394-4aea-8cdc-917cab7d3e00",
      flowId: "notify:49f89602-a394-4aea-8cdc-917cab7d3e00",
      platform: "telegram",
      platformMessageId: "7718912466:14680",
      deliveryState: "confirmed",
    }
    const report = await collectGatewayDoctor(
      { live: true },
      healthyDependencies({ liveProbe: async () => receipt }),
    )

    expect(report.ok).toBe(true)
    expect(report.lines.at(-1)).toBe(
      "PASS live-delivery — eventId=49f89602-a394-4aea-8cdc-917cab7d3e00 Telegram platformMessageId=7718912466:14680",
    )
  })

  test("--live rejects confirmed telemetry without a platform message id", async () => {
    const report = await collectGatewayDoctor(
      { live: true },
      healthyDependencies({
        liveProbe: async () => ({
          eventId: "e116ada5-0000-4000-8000-000000000000",
          flowId: "notify:e116ada5-0000-4000-8000-000000000000",
          platform: "telegram",
          platformMessageId: null,
          deliveryState: "confirmed",
        }),
      }),
    )

    expect(report.ok).toBe(false)
    expect(report.lines.at(-1)).toContain("FAIL live-delivery")
    expect(report.lines.at(-1)).toContain("platformMessageId=missing")
  })
})
