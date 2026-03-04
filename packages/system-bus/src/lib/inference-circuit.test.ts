import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __circuitTestUtils,
  checkCircuit,
  getAllCircuits,
  getCircuitState,
  isNoOpFailure,
  recordFailure,
  recordSuccess,
  resetAllCircuits,
  resetCircuit,
} from "./inference-circuit";

describe("inference-circuit", () => {
  let originalNow: typeof Date.now;

  beforeEach(() => {
    resetAllCircuits();
    originalNow = Date.now;
  });

  afterEach(() => {
    Date.now = originalNow;
  });

  test("default state is closed", () => {
    const result = checkCircuit("component-a", "action-a");

    expect(result.skip).toBe(false);
    expect(result.state).toBe("closed");
  });

  test("independent circuits per (component, action)", () => {
    for (let i = 0; i < 3; i++) {
      recordFailure("comp-a", "action-a");
    }

    const circuitA = checkCircuit("comp-a", "action-a");
    const circuitB = checkCircuit("comp-b", "action-b");
    const keys = [...getAllCircuits().keys()];

    expect(circuitA.skip).toBe(true);
    expect(circuitA.state).toBe("open");
    expect(circuitB.skip).toBe(false);
    expect(circuitB.state).toBe("closed");
    expect(keys).toContain("comp-a:action-a");
    expect(keys).toContain("comp-b:action-b");
  });

  test("opens after threshold consecutive failures", () => {
    for (let i = 0; i < 3; i++) {
      recordFailure("comp-open", "action-open");
    }

    const result = checkCircuit("comp-open", "action-open");

    expect(result.skip).toBe(true);
    expect(result.state).toBe("open");
  });

  test("half-open after cooldown", () => {
    for (let i = 0; i < 3; i++) {
      recordFailure("comp-cooldown", "action-cooldown");
    }

    const realNow = Date.now;
    Date.now = () => realNow() + __circuitTestUtils.NOOP_COOLDOWN_MS + 1;

    const result = checkCircuit("comp-cooldown", "action-cooldown");

    expect(result.skip).toBe(false);
    expect(result.state).toBe("half-open");
  });

  test("probe success closes circuit", () => {
    for (let i = 0; i < 3; i++) {
      recordFailure("comp-probe-success", "action-probe-success");
    }

    const realNow = Date.now;
    Date.now = () => realNow() + __circuitTestUtils.NOOP_COOLDOWN_MS + 1;

    const halfOpenCheck = checkCircuit("comp-probe-success", "action-probe-success");
    expect(halfOpenCheck.state).toBe("half-open");

    recordSuccess("comp-probe-success", "action-probe-success");
    const state = getCircuitState("comp-probe-success", "action-probe-success");
    const postCheck = checkCircuit("comp-probe-success", "action-probe-success");

    expect(state.state).toBe("closed");
    expect(postCheck.skip).toBe(false);
    expect(postCheck.state).toBe("closed");
  });

  test("probe failure re-opens circuit", () => {
    for (let i = 0; i < 3; i++) {
      recordFailure("comp-probe-failure", "action-probe-failure");
    }

    const realNow = Date.now;
    Date.now = () => realNow() + __circuitTestUtils.NOOP_COOLDOWN_MS + 1;

    const halfOpenCheck = checkCircuit("comp-probe-failure", "action-probe-failure");
    expect(halfOpenCheck.state).toBe("half-open");

    recordFailure("comp-probe-failure", "action-probe-failure");

    const postFailure = checkCircuit("comp-probe-failure", "action-probe-failure");
    expect(postFailure.skip).toBe(true);
    expect(postFailure.state).toBe("open");
  });

  test("window expiry resets failure counter", () => {
    recordFailure("comp-window", "action-window");
    recordFailure("comp-window", "action-window");

    const realNow = Date.now;
    Date.now = () => realNow() + __circuitTestUtils.NOOP_WINDOW_MS + 1;

    recordFailure("comp-window", "action-window");

    const check = checkCircuit("comp-window", "action-window");
    const state = getCircuitState("comp-window", "action-window");

    expect(check.skip).toBe(false);
    expect(check.state).toBe("closed");
    expect(state.consecutiveFailures).toBe(1);
  });

  test("resetCircuit clears state", () => {
    recordFailure("comp-reset", "action-reset");
    recordFailure("comp-reset", "action-reset");

    resetCircuit("comp-reset", "action-reset");

    expect(getAllCircuits().has("comp-reset:action-reset")).toBe(false);

    const check = checkCircuit("comp-reset", "action-reset");
    const state = getCircuitState("comp-reset", "action-reset");

    expect(check.skip).toBe(false);
    expect(check.state).toBe("closed");
    expect(state.consecutiveFailures).toBe(0);
  });

  test("isNoOpFailure detects no-op patterns", () => {
    expect(isNoOpFailure("inference_text_output_empty")).toBe(true);
    expect(isNoOpFailure("inference_json_parse_empty")).toBe(true);
    expect(isNoOpFailure("output_empty")).toBe(true);
    expect(isNoOpFailure("random error")).toBe(false);
  });
});
