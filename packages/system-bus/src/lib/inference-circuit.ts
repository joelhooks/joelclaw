/**
 * ADR-0191: Per-(component, action) inference circuit breaker.
 *
 * In-memory circuit state for the long-running system-bus worker process.
 * Tracks consecutive no-op failures per callsite. When threshold is reached,
 * opens circuit to skip expensive pi spawns. Half-open probing after cooldown
 * tests recovery.
 *
 * No-op failure signatures: empty/null output, JSON parse failure,
 * inference_rewrite_empty, inference_text_output_empty, inference_json_parse_empty.
 */

import { emitOtelEvent } from "../observability/emit";

// ── Configuration (env-overridable) ─────────────────────────────
const NOOP_THRESHOLD = Number(process.env.JOELCLAW_INFER_NOOP_THRESHOLD) || 3;
const NOOP_WINDOW_MS = Number(process.env.JOELCLAW_INFER_NOOP_WINDOW_MS) || 15 * 60 * 1000;
const NOOP_COOLDOWN_MS = Number(process.env.JOELCLAW_INFER_NOOP_COOLDOWN_MS) || 30 * 60 * 1000;
const HALF_OPEN_PROBES = Number(process.env.JOELCLAW_INFER_HALF_OPEN_PROBES) || 1;

// ── Types ───────────────────────────────────────────────────────
export type CircuitState = "closed" | "open" | "half-open";

export type CircuitData = {
  state: CircuitState;
  consecutiveFailures: number;
  firstFailureTs: number;
  lastFailureTs: number;
  lastOpenTs: number;
  totalOpens: number;
  halfOpenProbesRemaining: number;
};

export type CircuitCheck = {
  skip: boolean;
  state: CircuitState;
  reason: string;
};

// ── No-op failure detection ─────────────────────────────────────
const NOOP_ERROR_PATTERNS = [
  "inference_rewrite_empty",
  "inference_text_output_empty",
  "inference_json_parse_empty",
  "output_empty",
  "empty output",
  "json parse",
];

export function isNoOpFailure(error: string | Error): boolean {
  const message = typeof error === "string" ? error : error.message;
  const lower = message.toLowerCase();
  return NOOP_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
}

// ── State store ─────────────────────────────────────────────────
const circuits = new Map<string, CircuitData>();

function circuitKey(component: string, action: string): string {
  return `${component}:${action}`;
}

function defaultCircuit(): CircuitData {
  return {
    state: "closed",
    consecutiveFailures: 0,
    firstFailureTs: 0,
    lastFailureTs: 0,
    lastOpenTs: 0,
    totalOpens: 0,
    halfOpenProbesRemaining: HALF_OPEN_PROBES,
  };
}

function getOrCreate(key: string): CircuitData {
  let circuit = circuits.get(key);
  if (!circuit) {
    circuit = defaultCircuit();
    circuits.set(key, circuit);
  }
  return circuit;
}

// ── OTEL emission (transitions only — not every skip) ───────────
async function emitTransition(
  component: string,
  action: string,
  newState: CircuitState,
  circuit: CircuitData,
): Promise<void> {
  const otelAction =
    newState === "open"
      ? "inference.circuit.opened"
      : newState === "half-open"
        ? "inference.circuit.half_open"
        : "inference.circuit.closed";

  await emitOtelEvent({
    level: newState === "open" ? "warn" : "info",
    source: "system-bus",
    component,
    action: otelAction,
    success: newState !== "open",
    metadata: {
      inferenceComponent: component,
      inferenceAction: action,
      circuitState: newState,
      consecutiveFailures: circuit.consecutiveFailures,
      totalOpens: circuit.totalOpens,
      thresholdConfig: NOOP_THRESHOLD,
      windowConfig: NOOP_WINDOW_MS,
      cooldownConfig: NOOP_COOLDOWN_MS,
    },
  }).catch(() => {
    // Best-effort — don't let OTEL failures break inference
  });
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Check if inference should be skipped for this (component, action).
 * Call before each expensive pi spawn.
 */
export function checkCircuit(component: string, action: string): CircuitCheck {
  const key = circuitKey(component, action);
  const circuit = getOrCreate(key);
  const now = Date.now();

  if (circuit.state === "closed") {
    return { skip: false, state: "closed", reason: "" };
  }

  if (circuit.state === "open") {
    const elapsed = now - circuit.lastOpenTs;
    if (elapsed >= NOOP_COOLDOWN_MS) {
      // Transition to half-open
      circuit.state = "half-open";
      circuit.halfOpenProbesRemaining = HALF_OPEN_PROBES;
      emitTransition(component, action, "half-open", circuit);
      return { skip: false, state: "half-open", reason: "half-open probe" };
    }

    return {
      skip: true,
      state: "open",
      reason: `circuit_open (${circuit.consecutiveFailures} failures, ${Math.round(elapsed / 1000)}s/${Math.round(NOOP_COOLDOWN_MS / 1000)}s cooldown)`,
    };
  }

  // half-open: allow probe if probes remain
  if (circuit.halfOpenProbesRemaining > 0) {
    circuit.halfOpenProbesRemaining--;
    return { skip: false, state: "half-open", reason: "half-open probe" };
  }

  // No probes left — treat as open
  return {
    skip: true,
    state: "half-open",
    reason: "half-open probes exhausted, waiting for next cooldown",
  };
}

/**
 * Record a successful inference. Closes the circuit.
 */
export function recordSuccess(component: string, action: string): void {
  const key = circuitKey(component, action);
  const circuit = getOrCreate(key);
  const wasOpen = circuit.state !== "closed";

  circuit.state = "closed";
  circuit.consecutiveFailures = 0;
  circuit.firstFailureTs = 0;
  circuit.halfOpenProbesRemaining = HALF_OPEN_PROBES;

  if (wasOpen) {
    emitTransition(component, action, "closed", circuit);
  }
}

/**
 * Record a no-op failure. May open the circuit.
 */
export function recordFailure(component: string, action: string): void {
  const key = circuitKey(component, action);
  const circuit = getOrCreate(key);
  const now = Date.now();

  // If in half-open, any failure immediately re-opens
  if (circuit.state === "half-open") {
    circuit.state = "open";
    circuit.lastOpenTs = now;
    circuit.lastFailureTs = now;
    circuit.totalOpens++;
    emitTransition(component, action, "open", circuit);
    return;
  }

  // Window expiry — reset counter if first failure is outside window
  if (circuit.firstFailureTs > 0 && now - circuit.firstFailureTs > NOOP_WINDOW_MS) {
    circuit.consecutiveFailures = 0;
    circuit.firstFailureTs = 0;
  }

  circuit.consecutiveFailures++;
  circuit.lastFailureTs = now;
  if (circuit.firstFailureTs === 0) {
    circuit.firstFailureTs = now;
  }

  // Check threshold
  if (circuit.consecutiveFailures >= NOOP_THRESHOLD) {
    circuit.state = "open";
    circuit.lastOpenTs = now;
    circuit.totalOpens++;
    emitTransition(component, action, "open", circuit);
  }
}

/**
 * Get current circuit state for a (component, action) pair.
 */
export function getCircuitState(component: string, action: string): CircuitData {
  return { ...getOrCreate(circuitKey(component, action)) };
}

/**
 * Reset circuit for a specific (component, action).
 */
export function resetCircuit(component: string, action: string): void {
  circuits.delete(circuitKey(component, action));
}

/**
 * Get all tracked circuits.
 */
export function getAllCircuits(): Map<string, CircuitData> {
  return new Map(circuits);
}

/**
 * Reset all circuits. For testing only.
 */
export function resetAllCircuits(): void {
  circuits.clear();
}

// ── Test utilities ──────────────────────────────────────────────
export const __circuitTestUtils = {
  get NOOP_THRESHOLD() { return NOOP_THRESHOLD; },
  get NOOP_WINDOW_MS() { return NOOP_WINDOW_MS; },
  get NOOP_COOLDOWN_MS() { return NOOP_COOLDOWN_MS; },
  get HALF_OPEN_PROBES() { return HALF_OPEN_PROBES; },
  isNoOpFailure,
  circuitKey,
};
