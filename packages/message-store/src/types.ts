// Re-export core queue types
export type {
  CandidateMessage,
  DrainByPriorityOptions,
  PersistResult,
  StoredMessage as QueuedMessage,
  TelemetryEmitter,
} from "@joelclaw/queue";
export {
  Priority,
} from "@joelclaw/queue";

/**
 * Gateway-specific stored message type.
 * Extends the base queue message with gateway-specific fields.
 */
export interface StoredMessage {
  id: string;
  source: string;
  prompt: string;
  metadata?: Record<string, unknown>;
  timestamp: number;
  priority: number; // Use number here for compatibility
  acked: boolean;
}

/**
 * Inbound message with gateway-specific fields.
 * Used for priority classification and dedup.
 */
export type InboundMessage = {
  source: string;
  prompt: string;
  metadata?: Record<string, unknown>;
  event?: string | string[];
};
