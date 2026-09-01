export type NextAction = {
  command: string;
  description: string;
};

export type AgentEnvelope<T = unknown> = {
  ok: boolean;
  command: string;
  protocolVersion: 1;
  result?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  nextActions?: NextAction[];
  meta?: Record<string, unknown>;
};

export const DOCS_PROXY_VERSION = "0.2.0";

const PROTOCOL_VERSION = 1 as const;
const SERVICE = "web-docs-proxy";

export function ok<T>(command: string, result: T, nextActions?: NextAction[]): AgentEnvelope<T> {
  return {
    ok: true,
    command,
    protocolVersion: PROTOCOL_VERSION,
    result,
    nextActions,
    meta: {
      via: "next-route",
      service: SERVICE,
      version: DOCS_PROXY_VERSION,
    },
  };
}

export function fail(
  command: string,
  code: string,
  message: string,
  details?: unknown,
  nextActions?: NextAction[],
): AgentEnvelope {
  return {
    ok: false,
    command,
    protocolVersion: PROTOCOL_VERSION,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
    nextActions,
    meta: {
      via: "next-route",
      service: SERVICE,
      version: DOCS_PROXY_VERSION,
    },
  };
}
