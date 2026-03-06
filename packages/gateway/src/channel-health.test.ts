import { describe, expect, test } from "bun:test";
import {
  buildChannelHealthSnapshot,
  evaluateChannelHealthAlert,
  getInitialChannelHealthAlertState,
} from "./channel-health";

describe("channel health", () => {
  test("builds per-channel snapshot with degraded and muted summaries", () => {
    const snapshot = buildChannelHealthSnapshot({
      entries: {
        telegram: { configured: true, healthy: true, detail: "owner" },
        discord: { configured: true, healthy: false, detail: "not ready" },
        imessage: {
          configured: true,
          healthy: false,
          detail: "socket disconnected",
          muted: true,
          muteReason: "known flaky transport",
        },
        slack: { configured: false, healthy: false, detail: "disabled" },
      },
    });

    expect(snapshot.overall).toBe("degraded");
    expect(snapshot.configuredChannels).toEqual(["telegram", "discord", "imessage"]);
    expect(snapshot.degradedChannels).toEqual(["discord", "imessage"]);
    expect(snapshot.mutedChannels).toEqual(["imessage"]);
    expect(snapshot.entries.discord.status).toBe("degraded");
    expect(snapshot.entries.imessage.muteReason).toBe("known flaky transport");
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
});
