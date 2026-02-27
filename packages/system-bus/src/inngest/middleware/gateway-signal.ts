export type GatewaySignalLevel = "info" | "warn" | "error";

export interface GatewaySignalMeta {
  intent: string;
  level: GatewaySignalLevel;
  operator_action_required: boolean;
}

export function buildGatewaySignalMeta(intent: string, level: GatewaySignalLevel): GatewaySignalMeta {
  return {
    intent,
    level,
    operator_action_required: level === "warn" || level === "error",
  };
}
