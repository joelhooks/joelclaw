import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CommitNotificationListener } from "../src/daemon.js";
import { ForwarderDaemon } from "../src/daemon.js";
import type { PassReceipt } from "../src/forwarder.js";

const receipt: PassReceipt = {
  commitsSeen: 0,
  discovered: 0,
  excluded: 0,
  outcomes: { accepted: 0, deferred: 0, delivered: 0, indeterminate: 0, withheld: 0 },
  queuedInactiveCorrections: 0,
  queuedSupersessionCorrections: 0,
};

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

class FakeNotifications {
  connects = 0;
  events: string[] = [];
  listeners: Array<{
    close: () => void;
    disconnect: () => void;
    notify: () => void;
  }> = [];

  connect = async (onNotification: () => void, signal: AbortSignal): Promise<CommitNotificationListener> => {
    this.connects += 1;
    this.events.push("listen");
    const closed = deferred<void>();
    let settled = false;
    const close = () => {
      if (settled) return;
      settled = true;
      closed.resolve(undefined);
    };
    signal.addEventListener("abort", close, { once: true });
    this.listeners.push({ close, disconnect: close, notify: onNotification });
    return { closed: closed.promise, close: async () => close() };
  };
}

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
};

const makeDaemon = (input: {
  readonly notifications: FakeNotifications;
  readonly pending?: () => boolean;
  readonly runPass: () => Promise<PassReceipt>;
}) =>
  new ForwarderDaemon({
    connectNotificationListener: input.notifications.connect,
    fallbackIntervalMs: 15 * 60_000,
    hasPendingWork: input.pending ?? (() => false),
    reconnectIntervalMs: 5_000,
    reconciliationIntervalMs: 30_000,
    runPass: input.runPass,
  });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("event-driven forwarder daemon", () => {
  it("establishes LISTEN before startup catch-up and does not scan every 30 seconds while idle", async () => {
    const notifications = new FakeNotifications();
    const events = notifications.events;
    const daemon = makeDaemon({
      notifications,
      runPass: async () => {
        events.push("pass");
        return receipt;
      },
    });
    void daemon.run();
    await settle();

    expect(events.slice(0, 2)).toEqual(["listen", "pass"]);
    expect(events.filter((event) => event === "pass")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(events.filter((event) => event === "pass")).toHaveLength(1);
    await daemon.stop();
  });

  it("coalesces notification bursts and an event arriving during a pass into one serialized rerun", async () => {
    const notifications = new FakeNotifications();
    const first = deferred<PassReceipt>();
    let passes = 0;
    const daemon = makeDaemon({
      notifications,
      runPass: async () => {
        passes += 1;
        return passes === 1 ? first.promise : receipt;
      },
    });
    void daemon.run();
    await settle();
    expect(passes).toBe(1);

    notifications.listeners[0]?.notify();
    notifications.listeners[0]?.notify();
    notifications.listeners[0]?.notify();
    first.resolve(receipt);
    await settle();

    expect(passes).toBe(2);
    await daemon.stop();
  });

  it("reconnects after listener loss and catches up only after LISTEN is restored", async () => {
    const notifications = new FakeNotifications();
    let passes = 0;
    const daemon = makeDaemon({
      notifications,
      runPass: async () => {
        passes += 1;
        return receipt;
      },
    });
    void daemon.run();
    await settle();
    expect(passes).toBe(1);

    notifications.listeners[0]?.disconnect();
    await settle();
    expect(notifications.connects).toBe(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(notifications.connects).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await settle();

    expect(notifications.connects).toBe(2);
    expect(passes).toBe(2);
    await daemon.stop();
  });

  it("runs a slow recovery catch-up and short reconciliation only while delivery work remains", async () => {
    const notifications = new FakeNotifications();
    let passes = 0;
    let pending = true;
    const daemon = makeDaemon({
      notifications,
      pending: () => pending,
      runPass: async () => {
        passes += 1;
        if (passes === 2) pending = false;
        return receipt;
      },
    });
    void daemon.run();
    await settle();
    expect(passes).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    expect(passes).toBe(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(passes).toBe(2);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await settle();
    expect(passes).toBe(3);
    await daemon.stop();
  });

  it("stops the listener and cancels wake timers promptly", async () => {
    const notifications = new FakeNotifications();
    let passes = 0;
    const daemon = makeDaemon({
      notifications,
      runPass: async () => {
        passes += 1;
        return receipt;
      },
    });
    void daemon.run();
    await settle();
    await daemon.stop();

    notifications.listeners[0]?.notify();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(passes).toBe(1);
  });
});
