import { createActor, setup } from "xstate";

import type { PassReceipt } from "./forwarder.js";

export interface CommitNotificationListener {
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

export interface CommitNotificationSource {
  connectNotificationListener(
    onNotification: () => void,
    signal: AbortSignal,
  ): Promise<CommitNotificationListener>;
}

export interface DaemonTimer {
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
}

const systemTimer: DaemonTimer = {
  clearTimeout: (handle) => clearTimeout(handle),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
};

type DaemonEvent =
  | { readonly type: "DISCONNECTED" }
  | { readonly type: "FALLBACK" }
  | { readonly type: "LISTENING" }
  | { readonly pending: boolean; readonly type: "PASS_DONE" }
  | { readonly type: "RECONCILE" }
  | { readonly type: "RETRY_CONNECT" }
  | { readonly type: "STOP" }
  | { readonly type: "WAKE" };

export const forwarderDaemonMachine = setup({
  types: {
    events: {} as DaemonEvent,
  },
  guards: {
    hasPendingWork: ({ event }) => event.type === "PASS_DONE" && event.pending,
  },
}).createMachine({
  id: "supermemoryForwarderDaemon",
  initial: "active",
  on: { STOP: ".stopped" },
  states: {
    active: {
      type: "parallel",
      states: {
        connection: {
          initial: "connecting",
          states: {
            connecting: { on: { DISCONNECTED: "reconnecting", LISTENING: "listening" } },
            listening: { on: { DISCONNECTED: "reconnecting" } },
            reconnecting: { on: { RETRY_CONNECT: "connecting" } },
          },
        },
        work: {
          initial: "idle",
          states: {
            idle: { on: { FALLBACK: "running", WAKE: "running" } },
            running: {
              on: {
                PASS_DONE: [
                  { guard: "hasPendingWork", target: "draining" },
                  { target: "idle" },
                ],
                WAKE: "rerun",
              },
            },
            rerun: {
              on: {
                PASS_DONE: "running",
                WAKE: { target: "rerun", reenter: false },
              },
            },
            draining: {
              on: { FALLBACK: "running", RECONCILE: "running", WAKE: "running" },
            },
          },
        },
      },
    },
    stopped: { type: "final" },
  },
});

export interface ForwarderDaemonOptions {
  readonly connectNotificationListener: CommitNotificationSource["connectNotificationListener"];
  readonly fallbackIntervalMs: number;
  readonly hasPendingWork: () => boolean;
  readonly onPassError?: (error: unknown) => void;
  readonly onPassReceipt?: (receipt: PassReceipt) => void;
  readonly reconnectIntervalMs: number;
  readonly reconciliationIntervalMs: number;
  readonly runPass: () => Promise<PassReceipt>;
  readonly timer?: DaemonTimer;
}

export class ForwarderDaemon {
  readonly #actor = createActor(forwarderDaemonMachine);
  readonly #abort = new AbortController();
  readonly #done: Promise<void>;
  readonly #finish: () => void;
  readonly #input: ForwarderDaemonOptions;
  readonly #timer: DaemonTimer;
  #activeListener: CommitNotificationListener | null = null;
  #connectInFlight: Promise<void> | null = null;
  #fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  #listenerGeneration = 0;
  #passInFlight: Promise<void> | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #reconciliationTimer: ReturnType<typeof setTimeout> | null = null;
  #started = false;
  #stopping = false;

  constructor(input: ForwarderDaemonOptions) {
    this.#input = input;
    this.#timer = input.timer ?? systemTimer;
    let finish: () => void = () => undefined;
    this.#done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.#finish = finish;
    this.#actor.subscribe(() => this.#reconcile());
  }

  run(): Promise<void> {
    if (!this.#started) {
      this.#started = true;
      this.#actor.start();
      this.#reconcile();
    }
    return this.#done;
  }

  wake(): void {
    if (!this.#stopping) this.#actor.send({ type: "WAKE" });
  }

  async stop(): Promise<void> {
    if (!this.#started) {
      this.#started = true;
      this.#finish();
      return;
    }
    if (!this.#stopping) {
      this.#stopping = true;
      this.#abort.abort();
      this.#clearTimers();
      this.#actor.send({ type: "STOP" });
      const listener = this.#activeListener;
      this.#activeListener = null;
      if (listener !== null) await listener.close().catch(() => undefined);
      this.#maybeFinish();
    }
    await this.#done;
  }

  #clearTimers(): void {
    for (const handle of [this.#fallbackTimer, this.#reconnectTimer, this.#reconciliationTimer]) {
      if (handle !== null) this.#timer.clearTimeout(handle);
    }
    this.#fallbackTimer = null;
    this.#reconnectTimer = null;
    this.#reconciliationTimer = null;
  }

  #reconcile(): void {
    if (!this.#started) return;
    if (this.#stopping) {
      this.#clearTimers();
      this.#maybeFinish();
      return;
    }

    const snapshot = this.#actor.getSnapshot();
    if (snapshot.matches({ active: { connection: "connecting" } })) this.#startConnecting();
    if (snapshot.matches({ active: { connection: "reconnecting" } })) this.#scheduleReconnect();
    else if (this.#reconnectTimer !== null) {
      this.#timer.clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }

    if (snapshot.matches({ active: { work: "running" } }) && this.#passInFlight === null) this.#startPass();
    if (
      snapshot.matches({ active: { work: "idle" } }) ||
      snapshot.matches({ active: { work: "draining" } })
    ) {
      this.#scheduleFallback();
    } else if (this.#fallbackTimer !== null) {
      this.#timer.clearTimeout(this.#fallbackTimer);
      this.#fallbackTimer = null;
    }
    if (snapshot.matches({ active: { work: "draining" } })) this.#scheduleReconciliation();
    else if (this.#reconciliationTimer !== null) {
      this.#timer.clearTimeout(this.#reconciliationTimer);
      this.#reconciliationTimer = null;
    }
  }

  #startConnecting(): void {
    if (this.#connectInFlight !== null || this.#activeListener !== null) return;
    const generation = ++this.#listenerGeneration;
    const operation = (async () => {
      try {
        const listener = await this.#input.connectNotificationListener(
          () => {
            if (!this.#stopping && generation === this.#listenerGeneration) this.wake();
          },
          this.#abort.signal,
        );
        if (this.#stopping || generation !== this.#listenerGeneration) {
          await listener.close().catch(() => undefined);
          return;
        }
        this.#activeListener = listener;
        this.#actor.send({ type: "LISTENING" });
        this.wake();
        await listener.closed.catch(() => undefined);
        await listener.close().catch(() => undefined);
        if (this.#activeListener === listener) this.#activeListener = null;
        if (!this.#stopping && generation === this.#listenerGeneration) {
          this.#actor.send({ type: "DISCONNECTED" });
        }
      } catch {
        if (!this.#stopping && generation === this.#listenerGeneration) {
          this.#actor.send({ type: "DISCONNECTED" });
        }
      }
    })();
    this.#connectInFlight = operation;
    void operation.finally(() => {
      if (this.#connectInFlight === operation) this.#connectInFlight = null;
      this.#reconcile();
    });
  }

  #startPass(): void {
    const operation = (async () => {
      try {
        const receipt = await this.#input.runPass();
        this.#input.onPassReceipt?.(receipt);
      } catch (error) {
        this.#input.onPassError?.(error);
      } finally {
        if (!this.#stopping) {
          this.#actor.send({ type: "PASS_DONE", pending: this.#input.hasPendingWork() });
        }
      }
    })();
    this.#passInFlight = operation;
    void operation.finally(() => {
      if (this.#passInFlight === operation) this.#passInFlight = null;
      this.#reconcile();
    });
  }

  #scheduleFallback(): void {
    if (this.#fallbackTimer !== null) return;
    this.#fallbackTimer = this.#timer.setTimeout(() => {
      this.#fallbackTimer = null;
      if (!this.#stopping) this.#actor.send({ type: "FALLBACK" });
    }, this.#input.fallbackIntervalMs);
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTimer !== null) return;
    this.#reconnectTimer = this.#timer.setTimeout(() => {
      this.#reconnectTimer = null;
      if (!this.#stopping) this.#actor.send({ type: "RETRY_CONNECT" });
    }, this.#input.reconnectIntervalMs);
  }

  #scheduleReconciliation(): void {
    if (this.#reconciliationTimer !== null) return;
    this.#reconciliationTimer = this.#timer.setTimeout(() => {
      this.#reconciliationTimer = null;
      if (!this.#stopping) this.#actor.send({ type: "RECONCILE" });
    }, this.#input.reconciliationIntervalMs);
  }

  #maybeFinish(): void {
    if (!this.#stopping || this.#passInFlight !== null || this.#connectInFlight !== null) return;
    this.#actor.stop();
    this.#finish();
  }
}
