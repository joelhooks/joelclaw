/**
 * Channel-agnostic notification interface.
 *
 * A channel delivers messages with interactive actions to a human.
 * The channel encodes enough routing info in each action so that
 * callbacks can be resolved without the channel knowing about Restate.
 *
 * The callback path is:
 *   channel.send() → human sees buttons → human taps →
 *   channel-specific callback mechanism → generic resolver →
 *   Restate workflow handler
 */

export interface Action {
  /** Button label shown to the human */
  label: string;
  /** Value sent back when the human taps this action */
  value: string;
}

export interface NotificationMessage {
  /** Message text (markdown-ish, channel formats as appropriate) */
  text: string;
  /** Interactive actions (buttons) */
  actions: Action[];
  /** Workflow ID for callback routing */
  workflowId: string;
  /** Service name for callback routing */
  serviceName: string;
}

export interface SendResult {
  /** Channel-specific message identifier */
  messageId: string;
  /** Which channel delivered it */
  channel: string;
}

export interface CallbackData {
  /** Restate service name */
  serviceName: string;
  /** Restate workflow invocation ID */
  workflowId: string;
  /** Which action the human chose */
  action: string;
}

/**
 * Notification channel — delivers messages and receives callbacks.
 *
 * Implementations: Telegram, Console, Discord, Slack, etc.
 * Each channel handles its own callback mechanism (webhooks, polling, stdin).
 */
export interface NotificationChannel {
  readonly id: string;

  /** Send a message with interactive actions */
  send(message: NotificationMessage): Promise<SendResult>;

  /**
   * Start listening for callbacks.
   * When a callback arrives, call the resolver function.
   * Returns a stop function.
   */
  startCallbackListener(
    resolver: (data: CallbackData) => Promise<void>,
  ): Promise<() => void>;
}

/**
 * Encode callback data into a string for button payloads.
 * Format: restate:{serviceName}:{workflowId}:{action}
 */
export function encodeCallbackData(data: CallbackData): string {
  return `restate:${data.serviceName}:${data.workflowId}:${data.action}`;
}

/**
 * Decode callback data from a button payload string.
 */
export function decodeCallbackData(raw: string): CallbackData | null {
  const parts = raw.split(":");
  if (parts.length !== 4 || parts[0] !== "restate") return null;
  return {
    serviceName: parts[1],
    workflowId: parts[2],
    action: parts[3],
  };
}
