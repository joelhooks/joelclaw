export type { TelemetryEmitter } from "@joelclaw/telemetry";

export interface StoredMessage {
  id: string;
  source: string;
  prompt: string;
  metadata?: Record<string, unknown>;
  timestamp: number;
  priority: Priority;
  acked: boolean;
}

export type PersistResult = {
  streamId: string;
  priority: Priority;
};

export type InboundMessage = {
  source: string;
  prompt: string;
  metadata?: Record<string, unknown>;
  event?: string | string[];
};

export type DrainByPriorityOptions = {
  limit?: number;
  excludeIds?: Iterable<string>;
};

export type CandidateMessage = {
  message: StoredMessage;
  waitTimeMs: number;
  effectivePriority: Priority;
  promotedFrom?: Priority;
};

export enum Priority {
  P0 = 0,
  P1 = 1,
  P2 = 2,
  P3 = 3,
}
