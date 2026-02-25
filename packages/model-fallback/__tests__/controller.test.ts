import { afterEach, describe, expect, test, vi } from "vitest";
import { ModelFallbackController } from "../src/controller";
import type { FallbackSession, TelemetryEmitter } from "../src";

type TelemetryEvent = Parameters<TelemetryEmitter["emit"]>;

const BASE_CONFIG = {
  fallbackProvider: "anthropic",
  fallbackModel: "claude-sonnet-4-6",
  fallbackTimeoutMs: 1_000,
  fallbackAfterFailures: 3,
  recoveryProbeIntervalMs: 10_000,
};

type SessionState = {
  currentModel: { provider: string; id: string };
  setModel: ReturnType<typeof vi.fn>;
};

function createSession(): SessionState & { session: FallbackSession } {
  const state = {
    currentModel: { provider: "anthropic", id: "claude-opus-4-6" },
  };

  const setModel = vi.fn(async (model: unknown) => {
    const value = model as { provider: string; id: string };
    state.currentModel = { provider: value.provider, id: value.id };
  });

  return {
    currentModel: state.currentModel,
    setModel,
    session: {
      setModel,
      get model() {
        return state.currentModel;
      },
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ModelFallbackController", () => {
  test("activates fallback after N consecutive failures", async () => {
    const { session, setModel, currentModel } = createSession();
    const fallbackController = new ModelFallbackController(
      { ...BASE_CONFIG, fallbackAfterFailures: 2 },
      "anthropic",
      currentModel.id,
    );
    fallbackController.init(session, () => {});

    expect(await fallbackController.onPromptError(1)).toBe(false);
    expect(await fallbackController.onPromptError(2)).toBe(true);

    expect(setModel).toHaveBeenCalledTimes(1);
    expect(setModel).toHaveBeenCalledWith({ provider: "anthropic", id: "claude-sonnet-4-6" });
    expect(fallbackController.state.active).toBe(true);
    expect(fallbackController.state.activationCount).toBe(1);
  });

  test("activates fallback on prompt timeout (mock timers)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

    const { session, setModel, currentModel } = createSession();
    const fallbackController = new ModelFallbackController(
      { ...BASE_CONFIG, fallbackTimeoutMs: 500, fallbackAfterFailures: 99 },
      "anthropic",
      currentModel.id,
    );
    fallbackController.init(session, () => {});
    fallbackController.onPromptDispatched();

    vi.advanceTimersByTime(400);
    await Promise.resolve();
    expect(setModel).not.toHaveBeenCalled();

    vi.advanceTimersByTime(101);
    await Promise.resolve();
    expect(setModel).toHaveBeenCalledTimes(1);
    expect(fallbackController.state.active).toBe(true);
  });

  test("restores primary on successful recovery probe", async () => {
    vi.useFakeTimers();

    const { session, setModel, currentModel } = createSession();
    const fallbackController = new ModelFallbackController(
      { ...BASE_CONFIG, fallbackAfterFailures: 1, recoveryProbeIntervalMs: 250 },
      "anthropic",
      currentModel.id,
    );
    fallbackController.init(session, () => {});

    expect(await fallbackController.onPromptError(1)).toBe(true);
    expect(fallbackController.state.active).toBe(true);

    vi.advanceTimersByTime(250);
    await Promise.resolve();
    expect(setModel).toHaveBeenCalledTimes(2);
    expect(setModel).toHaveBeenLastCalledWith({ provider: "anthropic", id: "claude-opus-4-6" });
    expect(fallbackController.state.active).toBe(false);
  });

  test("reports fallback state", async () => {
    const { session, setModel, currentModel } = createSession();
    const fallbackController = new ModelFallbackController(
      { ...BASE_CONFIG, fallbackAfterFailures: 1 },
      "anthropic",
      currentModel.id,
    );
    fallbackController.init(session, () => {});

    expect(fallbackController.state).toEqual({
      active: false,
      activeSince: 0,
      activationCount: 0,
      primaryModel: currentModel.id,
      primaryProvider: currentModel.provider,
      fallbackModel: BASE_CONFIG.fallbackModel,
      fallbackProvider: BASE_CONFIG.fallbackProvider,
      lastRecoveryProbe: 0,
    });

    expect(await fallbackController.onPromptError(1)).toBe(true);
    expect(fallbackController.state.active).toBe(true);
    expect(fallbackController.state.activationCount).toBe(1);
    expect(fallbackController.state.primaryModel).toBe("claude-opus-4-6");
    expect(fallbackController.state.primaryProvider).toBe("anthropic");
    expect(fallbackController.state.fallbackModel).toBe("claude-sonnet-4-6");
    expect(fallbackController.state.fallbackProvider).toBe("anthropic");
    expect(fallbackController.state.lastRecoveryProbe).toBe(0);
    expect(fallbackController.state.activeSince).toBeGreaterThan(0);
  });

  test("cleans up timers on dispose", async () => {
    vi.useFakeTimers();

    const { session, setModel, currentModel } = createSession();
    const fallbackController = new ModelFallbackController(
      { ...BASE_CONFIG, fallbackAfterFailures: 1, recoveryProbeIntervalMs: 500 },
      "anthropic",
      currentModel.id,
    );
    fallbackController.init(session, () => {});

    expect(await fallbackController.onPromptError(1)).toBe(true);
    expect(fallbackController.state.active).toBe(true);
    expect(setModel).toHaveBeenCalledTimes(1);

    fallbackController.dispose();
    vi.advanceTimersByTime(10_000);
    await Promise.resolve();

    expect(setModel).toHaveBeenCalledTimes(1);
  });

  test("emits telemetry events", async () => {
    const events: TelemetryEvent[] = [];
    const telemetry: TelemetryEmitter = {
      emit: (action, detail, extra) => {
        events.push([action, detail, extra]);
      },
    };
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));

    const { session, currentModel } = createSession();
    const fallbackController = new ModelFallbackController(
      { ...BASE_CONFIG, fallbackAfterFailures: 1 },
      "anthropic",
      currentModel.id,
      telemetry,
    );
    fallbackController.init(session, () => {});

    expect(await fallbackController.onPromptError(1)).toBe(true);
    fallbackController.onPromptDispatched();
    vi.advanceTimersByTime(25);
    fallbackController.onFirstToken();
    vi.advanceTimersByTime(75);
    fallbackController.onTurnEnd();

    await Promise.resolve();

    const actions = events.map((event) => event[0]);
    expect(actions).toContain("model_fallback.swapped");
    expect(actions).toContain("prompt.latency");
  });
});
