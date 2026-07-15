export type GatewayOtelLevel = "debug" | "info" | "warn" | "error" | "fatal";

export type GatewayOtelInput = {
  level: GatewayOtelLevel;
  source?: string;
  sessionId?: string;
  systemId?: string;
  component: string;
  action: string;
  success: boolean;
  critical?: boolean;
  duration_ms?: number;
  error?: string;
  metadata?: Record<string, unknown>;
};

export interface TelemetryEmitter {
  emit(action: string, detail: string, extra?: Record<string, unknown>): void;
}
