/**
 * Webhook provider port interface (hexagonal architecture).
 * Each external service implements this to plug into the webhook gateway.
 * ADR-0048: Webhook Gateway for External Service Integration
 */

export type NormalizedEvent = {
  /** Event name without prefix, e.g. "comment.added" */
  name: string;
  /** Event payload matching the Inngest event schema */
  data: Record<string, unknown>;
  /** Unique key for idempotent event delivery */
  idempotencyKey: string;
};

export interface WebhookProvider {
  /** Provider identifier, e.g. "todoist", "github" */
  id: string;
  /** Event name prefix, e.g. "todoist" → events emit as "todoist/comment.added" */
  eventPrefix: string;
  /**
   * Verify the webhook signature.
   * @param rawBody Raw request body as string (needed for HMAC)
   * @param headers Request headers
   * @returns true if signature is valid
   */
  verifySignature(rawBody: string, headers: Record<string, string>): boolean;
  /**
   * Normalize the webhook payload into one or more internal events.
   * @param body Parsed JSON body
   * @param headers Request headers
   * @returns Array of normalized events to emit
   */
  normalizePayload(
    body: Record<string, unknown>,
    headers: Record<string, string>,
  ): NormalizedEvent[];
}
