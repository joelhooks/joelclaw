import { describe, expect, test } from "bun:test";
import { handoverMessagingTransports } from "../handover";
import type { ChatSdkRuntime } from "../instance";

function fakeRuntime(stop: () => Promise<void>): ChatSdkRuntime {
  return {
    chat: {} as ChatSdkRuntime["chat"],
    adapters: {},
    configured: { telegram: true, slack: true, discord: false },
    start: async () => {},
    stop,
  };
}

describe("Chat SDK transport ownership handover", () => {
  test("stops both legacy consumers before starting the SDK", async () => {
    const order: string[] = [];
    const runtime = fakeRuntime(async () => {
      order.push("sdk.stop");
    });

    const ownership = await handoverMessagingTransports({
      stopLegacyTelegram: async () => {
        order.push("legacy.telegram.stop");
      },
      stopLegacySlack: async () => {
        order.push("legacy.slack.stop");
      },
      startLegacyTelegram: async () => {
        order.push("legacy.telegram.start");
      },
      startLegacySlack: async () => {
        order.push("legacy.slack.start");
      },
      prepareSdk: () => {
        order.push("sdk.prepare");
      },
      startSdk: async (proof) => {
        expect(proof).toEqual({ legacyTransportsStopped: true });
        order.push("sdk.start");
        return runtime;
      },
      stopSdk: async () => runtime.stop(),
    });

    expect(order).toEqual([
      "legacy.telegram.stop",
      "legacy.slack.stop",
      "sdk.prepare",
      "sdk.start",
    ]);
    expect(ownership.receipts.map((receipt) => receipt.state)).toEqual([
      "legacy-active",
      "stopping-legacy",
      "legacy-stopped",
      "starting-sdk",
      "sdk-active",
    ]);
  });

  test("rolls back in SDK-stop then legacy-restart order", async () => {
    const order: string[] = [];
    const runtime = fakeRuntime(async () => {
      order.push("sdk.stop");
    });
    const ownership = await handoverMessagingTransports({
      stopLegacyTelegram: async () => {
        order.push("legacy.telegram.stop");
      },
      stopLegacySlack: async () => {
        order.push("legacy.slack.stop");
      },
      startLegacyTelegram: async () => {
        order.push("legacy.telegram.start");
      },
      startLegacySlack: async () => {
        order.push("legacy.slack.start");
      },
      startSdk: async () => {
        order.push("sdk.start");
        return runtime;
      },
      stopSdk: async () => runtime.stop(),
    });

    await ownership.rollback();
    await ownership.rollback();

    expect(order).toEqual([
      "legacy.telegram.stop",
      "legacy.slack.stop",
      "sdk.start",
      "sdk.stop",
      "legacy.telegram.start",
      "legacy.slack.start",
    ]);
    expect(ownership.receipts.at(-1)?.state).toBe("rolled-back");
  });

  test("allows rollback retry after a transient SDK stop failure", async () => {
    const order: string[] = [];
    let stopAttempts = 0;
    const runtime = fakeRuntime(async () => {});
    const ownership = await handoverMessagingTransports({
      stopLegacyTelegram: async () => {},
      stopLegacySlack: async () => {},
      startLegacyTelegram: async () => {
        order.push("legacy.telegram.start");
      },
      startLegacySlack: async () => {
        order.push("legacy.slack.start");
      },
      startSdk: async () => runtime,
      stopSdk: async () => {
        stopAttempts += 1;
        order.push(`sdk.stop.${stopAttempts}`);
        if (stopAttempts === 1) throw new Error("transient stop failure");
      },
    });

    await expect(ownership.rollback()).rejects.toThrow("transient stop failure");
    await ownership.rollback();

    expect(order).toEqual([
      "sdk.stop.1",
      "sdk.stop.2",
      "legacy.telegram.start",
      "legacy.slack.start",
    ]);
  });

  test("restores only transports that actually stopped after a partial failure", async () => {
    const order: string[] = [];
    const runtime = fakeRuntime(async () => {
      order.push("sdk.stop");
    });

    await expect(
      handoverMessagingTransports({
        stopLegacyTelegram: async () => {
          order.push("legacy.telegram.stop");
        },
        stopLegacySlack: async () => {
          order.push("legacy.slack.stop.fail");
          throw new Error("socket stop failed");
        },
        startLegacyTelegram: async () => {
          order.push("legacy.telegram.start");
        },
        startLegacySlack: async () => {
          order.push("legacy.slack.start");
        },
        startSdk: async () => runtime,
        stopSdk: async () => runtime.stop(),
      }),
    ).rejects.toThrow("socket stop failed");

    expect(order).toEqual([
      "legacy.telegram.stop",
      "legacy.slack.stop.fail",
      "legacy.telegram.start",
    ]);
  });

  test("does not restart legacy when SDK shutdown is unproven", async () => {
    const order: string[] = [];

    await expect(
      handoverMessagingTransports({
        stopLegacyTelegram: async () => {
          order.push("legacy.telegram.stop");
        },
        stopLegacySlack: async () => {
          order.push("legacy.slack.stop");
        },
        startLegacyTelegram: async () => {
          order.push("legacy.telegram.start");
        },
        startLegacySlack: async () => {
          order.push("legacy.slack.start");
        },
        startSdk: async () => {
          order.push("sdk.start.fail");
          throw new Error("sdk startup failed");
        },
        stopSdk: async () => {
          order.push("sdk.stop.fail");
          throw new Error("sdk shutdown failed");
        },
      }),
    ).rejects.toThrow("SDK shutdown is unproven");

    expect(order).toEqual([
      "legacy.telegram.stop",
      "legacy.slack.stop",
      "sdk.start.fail",
      "sdk.stop.fail",
    ]);
  });

  test("stops a partially started SDK before restoring both legacy consumers", async () => {
    const order: string[] = [];
    const runtime = fakeRuntime(async () => {
      order.push("sdk.stop");
    });

    await expect(
      handoverMessagingTransports({
        stopLegacyTelegram: async () => {
          order.push("legacy.telegram.stop");
        },
        stopLegacySlack: async () => {
          order.push("legacy.slack.stop");
        },
        startLegacyTelegram: async () => {
          order.push("legacy.telegram.start");
        },
        startLegacySlack: async () => {
          order.push("legacy.slack.start");
        },
        startSdk: async () => {
          order.push("sdk.start.fail");
          throw new Error("sdk startup failed");
        },
        stopSdk: async () => runtime.stop(),
      }),
    ).rejects.toThrow("sdk startup failed");

    expect(order).toEqual([
      "legacy.telegram.stop",
      "legacy.slack.stop",
      "sdk.start.fail",
      "sdk.stop",
      "legacy.telegram.start",
      "legacy.slack.start",
    ]);
  });
});
