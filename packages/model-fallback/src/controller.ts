/**
 * Model fallback controller (ADR-0091).
 *
 * Monitors prompt latency and failures. When the primary model is
 * unresponsive (timeout) or broken (consecutive errors), hot-swaps
 * to a fallback model via session.setModel(). Periodically probes
 * the primary model to recover automatically.
 */
import {
  MODEL_CATALOG,
  normalizeModel as normalizeCatalogModel,
} from "@joelclaw/inference-router";
import {
  type FallbackConfig,
  type FallbackNotifier,
  type FallbackSession,
  type FallbackState,
  type TelemetryEmitter,
} from "./types";

type ModelRef = { provider: string; id: string };

function resolveCatalogModel(provider: string | undefined, model: string): ModelRef | undefined {
  if (!provider) return undefined;
  const normalizedModel = normalizeCatalogModel(model, true)
    ?? normalizeCatalogModel(`${provider}/${model}`, true);
  if (!normalizedModel) return undefined;

  const catalogModel = MODEL_CATALOG[normalizedModel];
  if (!catalogModel) return undefined;
  if (catalogModel.provider !== provider) return undefined;

  const [_, modelId] = normalizedModel.split("/");
  if (!modelId) return undefined;
  return { provider: catalogModel.provider, id: modelId };
}

export class ModelFallbackController {
  private session: FallbackSession | undefined;
  private notify: FallbackNotifier = () => {};
  private telemetry?: TelemetryEmitter;
  private config: FallbackConfig;
  private primaryModel: ModelRef;

  private _active = false;
  private _activeSince = 0;
  private _activationCount = 0;
  private _lastRecoveryProbe = 0;
  private _probesSinceFallback = 0;

  // Streaming timeout tracking
  private _promptDispatchedAt = 0;
  private _firstTokenAt = 0;
  private _timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  private _timeoutPaused = false;
  private _timeoutPausedAt = 0;
  private _timeoutRemainingMs = 0;

  // Recovery probe timer
  private _recoveryTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    config: FallbackConfig,
    primaryProvider: string,
    primaryModelId: string,
    telemetry?: TelemetryEmitter,
  ) {
    this.config = config;
    this.primaryModel = { provider: primaryProvider, id: primaryModelId };
    this.telemetry = telemetry;
  }

  /** Wire up the pi session and notification callback. Call after session creation. */
  init(session: FallbackSession, notify: FallbackNotifier): void {
    this.session = session;
    this.notify = notify;

    // Start recovery probe timer
    this._recoveryTimer = setInterval(() => {
      void this._maybeRecoverPrimary();
    }, this.config.recoveryProbeIntervalMs);
    if (this._recoveryTimer && typeof this._recoveryTimer === "object" && "unref" in this._recoveryTimer) {
      (this._recoveryTimer as NodeJS.Timeout).unref();
    }
  }

  /** Current fallback state for status endpoints. */
  get state(): FallbackState {
    return {
      active: this._active,
      activeSince: this._activeSince,
      activationCount: this._activationCount,
      primaryModel: this.primaryModel.id,
      primaryProvider: this.primaryModel.provider,
      fallbackModel: this.config.fallbackModel,
      fallbackProvider: this.config.fallbackProvider,
      lastRecoveryProbe: this._lastRecoveryProbe,
    };
  }

  get isActive(): boolean {
    return this._active;
  }

  // ── Event hooks (called by daemon) ──────────────────────

  /** Called when a prompt is dispatched to the session. */
  onPromptDispatched(): void {
    this._promptDispatchedAt = Date.now();
    this._firstTokenAt = 0;
    console.log("[gateway:fallback] prompt dispatched, starting timeout watch", {
      timeoutMs: this.config.fallbackTimeoutMs,
      fallback: `${this.config.fallbackProvider}/${this.config.fallbackModel}`,
    });
    this._startTimeoutWatch();
  }

  /** Called when the first streaming token arrives. */
  onFirstToken(): void {
    if (this._firstTokenAt === 0) {
      this._firstTokenAt = Date.now();
      this._clearTimeoutWatch();
    }
  }

  /** Called on turn_end — prompt completed successfully. */
  onTurnEnd(): void {
    this._clearTimeoutWatch();

    const endedAt = Date.now();
    if (this._promptDispatchedAt > 0) {
      const totalDuration = endedAt - this._promptDispatchedAt;
      const ttftMs =
        this._firstTokenAt > this._promptDispatchedAt
          ? this._firstTokenAt - this._promptDispatchedAt
          : undefined;
      const nearMissThreshold = this.config.fallbackTimeoutMs * 0.75;
      const nearMiss = totalDuration > nearMissThreshold;
      const currentModel = this.session?.model;
      const model = currentModel
        ? `${currentModel.provider}/${currentModel.id}`
        : `${this.primaryModel.provider}/${this.primaryModel.id}`;

      this._emit({
        level: totalDuration > 60_000 ? "info" : "debug",
        component: "daemon.fallback",
        action: "prompt.latency",
        success: true,
        duration_ms: totalDuration,
        metadata: {
          total_ms: totalDuration,
          model,
          on_fallback: this._active,
          near_miss: nearMiss,
          ...(ttftMs !== undefined ? { ttft_ms: ttftMs } : {}),
        },
      });

      if (nearMiss) {
        this._emit({
          level: "warn",
          component: "daemon.fallback",
          action: "prompt.near_miss",
          success: true,
          metadata: {
            total_ms: totalDuration,
            threshold_ms: this.config.fallbackTimeoutMs,
            pct_of_timeout: Number(((totalDuration / this.config.fallbackTimeoutMs) * 100).toFixed(1)),
            ...(ttftMs !== undefined ? { ttft_ms: ttftMs } : {}),
          },
        });
      }
    }

    this._promptDispatchedAt = 0;
    this._firstTokenAt = 0;
  }

  /** Called when prompt() throws. Returns true if fallback was activated. */
  async onPromptError(consecutiveFailures: number): Promise<boolean> {
    this._clearTimeoutWatch();

    if (this._active) return false; // already on fallback
    if (consecutiveFailures < this.config.fallbackAfterFailures) return false;

    return this._activateFallback(`${consecutiveFailures} consecutive prompt failures`, consecutiveFailures);
  }

  // ── Internals ───────────────────────────────────────────

  private _startTimeoutWatch(): void {
    this._clearTimeoutWatch();

    this._timeoutTimer = setTimeout(() => {
      console.log("[gateway:fallback] timeout timer fired", {
        firstTokenAt: this._firstTokenAt,
        active: this._active,
        elapsed: Date.now() - this._promptDispatchedAt,
      });
      if (this._firstTokenAt > 0) return; // tokens arrived, we're fine
      if (this._active) return; // already on fallback

      console.warn("[gateway:fallback] timeout — no tokens received", {
        timeoutMs: this.config.fallbackTimeoutMs,
        promptDispatchedAt: new Date(this._promptDispatchedAt).toISOString(),
      });
      void this._activateFallback(`no streaming tokens after ${Math.round(this.config.fallbackTimeoutMs / 1000)}s`);
    }, this.config.fallbackTimeoutMs);
    // NOTE: Do NOT unref() — this timer is critical for fallback detection.
    // unref() in Bun may suppress the callback entirely.
  }

  private _clearTimeoutWatch(): void {
    if (this._timeoutTimer) {
      clearTimeout(this._timeoutTimer);
      this._timeoutTimer = undefined;
    }
    this._timeoutPaused = false;
    this._timeoutRemainingMs = 0;
  }

  /**
   * Pause the timeout watch (e.g. during compaction).
   * The remaining timeout is saved and can be resumed.
   */
  pauseTimeoutWatch(): void {
    if (!this._timeoutTimer || this._timeoutPaused) return;
    const elapsed = Date.now() - this._promptDispatchedAt;
    this._timeoutRemainingMs = Math.max(0, this.config.fallbackTimeoutMs - elapsed);
    clearTimeout(this._timeoutTimer);
    this._timeoutTimer = undefined;
    this._timeoutPaused = true;
    this._timeoutPausedAt = Date.now();
    console.log("[gateway:fallback] timeout watch paused (compaction)", {
      remainingMs: this._timeoutRemainingMs,
    });
  }

  /**
   * Resume the timeout watch after a pause. Resets the timer with the
   * remaining duration plus a grace period for post-compaction inference.
   */
  resumeTimeoutWatch(): void {
    if (!this._timeoutPaused) return;
    this._timeoutPaused = false;
    // Give a full timeout window after compaction — the next prompt
    // effectively starts fresh from the model's perspective
    const gracePeriodMs = this.config.fallbackTimeoutMs;
    this._promptDispatchedAt = Date.now();
    this._firstTokenAt = 0;
    console.log("[gateway:fallback] timeout watch resumed (post-compaction)", {
      newTimeoutMs: gracePeriodMs,
      pausedForMs: Date.now() - this._timeoutPausedAt,
    });
    this._startTimeoutWatch();
  }

  private async _activateFallback(reason: string, consecutiveFailures?: number): Promise<boolean> {
    if (!this.session) return false;

    const currentModel = this.session.model;
    const fromModel = currentModel
      ? `${currentModel.provider}/${currentModel.id}`
      : `${this.primaryModel.provider}/${this.primaryModel.id}`;
    const toModel = `${this.config.fallbackProvider}/${this.config.fallbackModel}`;

    const fallbackModelObj = resolveCatalogModel(
      this.config.fallbackProvider,
      this.config.fallbackModel,
    );
    if (!fallbackModelObj) {
      console.error("[gateway:fallback] fallback model not found", {
        provider: this.config.fallbackProvider,
        model: this.config.fallbackModel,
      });
      this._emit({
        level: "error",
        component: "daemon.fallback",
        action: "fallback.model_not_found",
        success: false,
        error: `${this.config.fallbackProvider}/${this.config.fallbackModel} not found`,
      });
      return false;
    }

    const now = Date.now();
    const promptElapsedMs = this._promptDispatchedAt > 0 ? now - this._promptDispatchedAt : 0;
    const ttftMs =
      this._firstTokenAt > this._promptDispatchedAt && this._promptDispatchedAt > 0
        ? this._firstTokenAt - this._promptDispatchedAt
        : undefined;

    try {
      await this.session.setModel(fallbackModelObj);
      this._active = true;
      this._activeSince = Date.now();
      this._activationCount += 1;
      this._probesSinceFallback = 0;

      const msg = `⚠️ Gateway falling back to ${this.config.fallbackProvider}/${this.config.fallbackModel}\nReason: ${reason}\nWill probe primary every ${Math.round(this.config.recoveryProbeIntervalMs / 60_000)}min`;
      console.warn("[gateway:fallback] activated", {
        reason,
        fallback: `${this.config.fallbackProvider}/${this.config.fallbackModel}`,
        activationCount: this._activationCount,
      });
      this.notify(msg);

      this._emit({
        level: "warn",
        component: "daemon.fallback",
        action: "model_fallback.swapped",
        success: true,
        metadata: {
          from: fromModel,
          to: toModel,
          reason,
          consecutiveFailures: consecutiveFailures ?? 0,
          prompt_elapsed_ms: promptElapsedMs,
          threshold_timeout_ms: this.config.fallbackTimeoutMs,
          threshold_failures: this.config.fallbackAfterFailures,
          ...(ttftMs !== undefined ? { ttft_ms: ttftMs } : {}),
        },
      });

      return true;
    } catch (error) {
      console.error("[gateway:fallback] setModel failed", { error: String(error) });
      this._emit({
        level: "error",
        component: "daemon.fallback",
        action: "fallback.setModel.failed",
        success: false,
        error: String(error),
      });
      return false;
    }
  }

  private async _maybeRecoverPrimary(): Promise<void> {
    if (!this._active || !this.session) return;

    this._lastRecoveryProbe = Date.now();
    this._probesSinceFallback += 1;
    const probeCount = this._probesSinceFallback;
    const primary = `${this.primaryModel.provider}/${this.primaryModel.id}`;
    const downtimeMs = this._activeSince > 0 ? Date.now() - this._activeSince : 0;

    const primaryModelObj = resolveCatalogModel(
      this.primaryModel.provider,
      this.primaryModel.id,
    );
    if (!primaryModelObj) return;

    try {
      await this.session.setModel(primaryModelObj);
      this._active = false;
      this._activeSince = 0;
      this._probesSinceFallback = 0;

      const msg = `✅ Gateway recovered to primary model: ${this.primaryModel.provider}/${this.primaryModel.id}`;
      console.log("[gateway:fallback] recovered to primary", {
        primary,
      });
      this.notify(msg);

      this._emit({
        level: "info",
        component: "daemon.fallback",
        action: "model_fallback.primary_restored",
        success: true,
        metadata: {
          primary,
          downtime_ms: downtimeMs,
          activationCount: this._activationCount,
        },
      });
    } catch (error) {
      // Primary still broken — stay on fallback
      console.warn("[gateway:fallback] recovery probe failed — staying on fallback", {
        error: String(error),
      });
      this._emit({
        level: "info",
        component: "daemon.fallback",
        action: "model_fallback.probe_failed",
        success: false,
        error: String(error),
        metadata: {
          primary,
          downtime_ms: downtimeMs,
          probeCount,
          error: String(error),
        },
      });
    }
  }

  private _emit(event: Parameters<TelemetryEmitter["emit"]>[0]): void {
    this.telemetry?.emit(event);
  }

  dispose(): void {
    this._clearTimeoutWatch();
    if (this._recoveryTimer) {
      clearInterval(this._recoveryTimer);
      this._recoveryTimer = undefined;
    }
  }
}
