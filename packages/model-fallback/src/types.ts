export type FallbackConfig = {
  fallbackProvider: string;
  fallbackModel: string;
  fallbackTimeoutMs: number;
  fallbackAfterFailures: number;
  recoveryProbeIntervalMs: number;
};

export type FallbackState = {
  /** Are we currently on the fallback model? */
  active: boolean;
  /** When we switched to fallback (0 if not active) */
  activeSince: number;
  /** Number of times fallback has activated this session */
  activationCount: number;
  /** Primary model ID */
  primaryModel: string;
  /** Primary provider */
  primaryProvider: string;
  /** Fallback model ID */
  fallbackModel: string;
  /** Fallback provider */
  fallbackProvider: string;
  /** Last recovery probe timestamp */
  lastRecoveryProbe: number;
};

export type FallbackSession = {
  setModel: (model: unknown) => Promise<void>;
  readonly model: { provider: string; id: string } | undefined;
};

export type FallbackNotifier = (text: string) => void;

export interface TelemetryEmitter {
  emit(event: {
    level: string;
    component: string;
    action: string;
    success: boolean;
    duration_ms?: number;
    error?: string;
    metadata?: Record<string, unknown>;
  }): void;
}
