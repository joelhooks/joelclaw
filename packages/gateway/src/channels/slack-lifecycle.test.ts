import { describe, expect, test } from "bun:test";
import {
  initialSlackSocketLifecycle,
  transitionSlackSocketLifecycle,
} from "./slack-lifecycle";

describe("Slack Socket Mode lifecycle", () => {
  test("tracks a connected socket independently from process startup", () => {
    const initial = initialSlackSocketLifecycle(100);
    const connecting = transitionSlackSocketLifecycle(initial, "connecting", 200);
    const connected = transitionSlackSocketLifecycle(connecting, "connected", 300);

    expect(connected).toEqual({
      state: "connected",
      lastTransitionAt: 300,
      lastConnectedAt: 300,
      reconnectCount: 0,
    });
  });

  test("keeps the last good connection receipt while reconnecting", () => {
    const connected = transitionSlackSocketLifecycle(
      initialSlackSocketLifecycle(100),
      "connected",
      200,
    );
    const reconnecting = transitionSlackSocketLifecycle(connected, "reconnecting", 300);
    const disconnected = transitionSlackSocketLifecycle(reconnecting, "disconnected", 400);

    expect(disconnected.state).toBe("disconnected");
    expect(disconnected.lastConnectedAt).toBe(200);
    expect(disconnected.lastTransitionAt).toBe(400);
    expect(disconnected.reconnectCount).toBe(1);
  });
});
