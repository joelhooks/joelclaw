import { describe, expect, test } from "bun:test";
import {
  buildChannelHealthSnapshot,
  evaluateChannelHealPolicy,
  evaluateChannelHealthAlert,
  getInitialChannelHealState,
  getInitialChannelHealthAlertState,
  recordChannelHealAttemptResult,
} from "./channel-health";

describe("channel health", () => {
  test("builds per-channel snapshot with degraded, muted, and heal-policy summaries", () => {
    const snapshot = buildChannelHealthSnapshot({
      entries: {
        telegram: { configured: true, healthy: true, detail: "owner" },
        discord: {
          configured: true,
          healthy: false,
          detail: "not ready",
          healPolicy: "restart",
          healReason: "discord client not ready",
        },
        imessage: {
          configured: true,
          healthy: false,
          detail: "socket disconnected",
          muted: true,
          muteReason: "known flaky transport",
          healPolicy: "manual",
          healReason: "FDA re-grant needed",
        },
        slack: { configured: false, healthy: false, detail: "disabled" },
      },
    });

    expect(snapshot.overall).toBe("degraded");
    expect(snapshot.configuredChannels).toEqual(["telegram", "discord", "imessage"]);
    expect(snapshot.degradedChannels).toEqual(["discord", "imessage"]);
    expect(snapshot.mutedChannels).toEqual(["imessage"]);
    expect(snapshot.entries.discord.status).toBe("degraded");
    expect(snapshot.entries.discord.healPolicy).toBe("restart");
    expect(snapshot.entries.imessage.muteReason).toBe("known flaky transport");
    expect(snapshot.entries.imessage.healPolicy).toBe("manual");
    expect(snapshot.entries.slack.status).toBe("disabled");
  });

  test("emits degraded event when a configured channel first goes unhealthy", () => {
    const decision = evaluateChannelHealthAlert(
      buildChannelHealthSnapshot({
        entries: {
          telegram: { configured: true, healthy: false, detail: "polling stopped" },
          discord: { configured: false, healthy: false, detail: "disabled" },
          imessage: { configured: false, healthy: false, detail: "disabled" },
          slack: { configured: false, healthy: false, detail: "disabled" },
        },
      }),
      getInitialChannelHealthAlertState(),
      123,
    );

    expect(decision.events).toEqual([
      {
        channel: "telegram",
        kind: "degraded",
        status: "degraded",
        detail: "polling stopped",
        muted: false,
        muteReason: null,
        at: 123,
      },
    ]);
    expect(decision.nextState.channels.telegram.status).toBe("degraded");
    expect(decision.nextState.channels.telegram.lastEventAt).toBe(123);
    expect(decision.nextState.lastEvent?.channel).toBe("telegram");
  });

  test("emits recovered event when a degraded channel becomes healthy", () => {
    const degraded = evaluateChannelHealthAlert(
      buildChannelHealthSnapshot({
        entries: {
          telegram: { configured: true, healthy: false, detail: "polling stopped" },
          discord: { configured: false, healthy: false, detail: "disabled" },
          imessage: { configured: false, healthy: false, detail: "disabled" },
          slack: { configured: false, healthy: false, detail: "disabled" },
        },
      }),
      getInitialChannelHealthAlertState(),
      100,
    );

    const recovered = evaluateChannelHealthAlert(
      buildChannelHealthSnapshot({
        entries: {
          telegram: { configured: true, healthy: true, detail: "owner" },
          discord: { configured: false, healthy: false, detail: "disabled" },
          imessage: { configured: false, healthy: false, detail: "disabled" },
          slack: { configured: false, healthy: false, detail: "disabled" },
        },
      }),
      degraded.nextState,
      220,
    );

    expect(recovered.events).toEqual([
      {
        channel: "telegram",
        kind: "recovered",
        status: "healthy",
        detail: "owner",
        muted: false,
        muteReason: null,
        at: 220,
      },
    ]);
    expect(recovered.nextState.channels.telegram.status).toBe("healthy");
    expect(recovered.nextState.channels.telegram.lastRecoveredAt).toBe(220);
    expect(recovered.nextState.lastEvent?.kind).toBe("recovered");
  });

  test("does not emit an event when a channel becomes healthy from disabled", () => {
    const decision = evaluateChannelHealthAlert(
      buildChannelHealthSnapshot({
        entries: {
          telegram: { configured: true, healthy: true, detail: "owner" },
          discord: { configured: false, healthy: false, detail: "disabled" },
          imessage: { configured: false, healthy: false, detail: "disabled" },
          slack: { configured: false, healthy: false, detail: "disabled" },
        },
      }),
      getInitialChannelHealthAlertState(),
      100,
    );

    expect(decision.events).toHaveLength(0);
    expect(decision.nextState.channels.telegram.status).toBe("healthy");
    expect(decision.nextState.lastEvent).toBeNull();
  });

  test("schedules restart heal after degraded streak crosses threshold", () => {
    const snapshot = buildChannelHealthSnapshot({
      entries: {
        telegram: { configured: false, healthy: false, detail: "disabled" },
        discord: {
          configured: true,
          healthy: false,
          detail: "client not ready",
          healPolicy: "restart",
          healReason: "discord client not ready",
        },
        imessage: { configured: false, healthy: false, detail: "disabled" },
        slack: { configured: false, healthy: false, detail: "disabled" },
      },
    });

    const first = evaluateChannelHealPolicy(snapshot, getInitialChannelHealState(), 100, {
      restartAfterConsecutiveDegraded: 2,
      cooldownMs: 60_000,
    });
    expect(first.actions).toHaveLength(0);
    expect(first.nextState.channels.discord.consecutiveDegradedCount).toBe(1);

    const second = evaluateChannelHealPolicy(snapshot, first.nextState, 200, {
      restartAfterConsecutiveDegraded: 2,
      cooldownMs: 60_000,
    });
    expect(second.actions).toEqual([
      {
        channel: "discord",
        policy: "restart",
        detail: "client not ready",
        reason: "discord client not ready",
        muted: false,
        at: 200,
      },
    ]);
    expect(second.nextState.channels.discord.lastAttemptStatus).toBe("scheduled");
    expect(second.nextState.channels.discord.attempts).toBe(1);
  });

  test("does not schedule restart for muted or manual channels", () => {
    const snapshot = buildChannelHealthSnapshot({
      entries: {
        telegram: {
          configured: true,
          healthy: false,
          detail: "passive poll follower",
          healPolicy: "manual",
          healReason: "ownership conflict",
        },
        discord: { configured: false, healthy: false, detail: "disabled" },
        imessage: {
          configured: true,
          healthy: false,
          detail: "socket disconnected",
          muted: true,
          muteReason: "FDA needed",
          healPolicy: "restart",
          healReason: "socket disconnected",
        },
        slack: { configured: false, healthy: false, detail: "disabled" },
      },
    });

    const decision = evaluateChannelHealPolicy(snapshot, getInitialChannelHealState(), 100, {
      restartAfterConsecutiveDegraded: 1,
      cooldownMs: 60_000,
    });

    expect(decision.actions).toHaveLength(0);
    expect(decision.nextState.channels.telegram.policy).toBe("manual");
    expect(decision.nextState.channels.imessage.consecutiveDegradedCount).toBe(1);
    expect(decision.nextState.channels.imessage.lastAttemptStatus).toBe("idle");
  });

  test("records heal attempt results", () => {
    const scheduled = evaluateChannelHealPolicy(
      buildChannelHealthSnapshot({
        entries: {
          telegram: { configured: false, healthy: false, detail: "disabled" },
          discord: {
            configured: true,
            healthy: false,
            detail: "client not ready",
            healPolicy: "restart",
          },
          imessage: { configured: false, healthy: false, detail: "disabled" },
          slack: { configured: false, healthy: false, detail: "disabled" },
        },
      }),
      getInitialChannelHealState(),
      100,
      { restartAfterConsecutiveDegraded: 1, cooldownMs: 60_000 },
    );

    const succeeded = recordChannelHealAttemptResult(scheduled.nextState, {
      channel: "discord",
      succeeded: true,
    });
    expect(succeeded.channels.discord.lastAttemptStatus).toBe("succeeded");
    expect(succeeded.channels.discord.lastAttemptError).toBeNull();

    const failed = recordChannelHealAttemptResult(succeeded, {
      channel: "discord",
      succeeded: false,
      error: "restart exploded",
    });
    expect(failed.channels.discord.lastAttemptStatus).toBe("failed");
    expect(failed.channels.discord.lastAttemptError).toBe("restart exploded");
  });
});
