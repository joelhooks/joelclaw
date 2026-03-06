/**
 * No-op notification channel — safe default for headless host workers.
 *
 * Accepts sends, logs intent, and never binds stdin or external callbacks.
 */

import type {
  CallbackData,
  NotificationChannel,
  NotificationMessage,
  SendResult,
} from "./types";

export class NoopChannel implements NotificationChannel {
  readonly id = "noop";

  async send(message: NotificationMessage): Promise<SendResult> {
    const messageId = `noop-${Date.now()}`;
    console.log(`📭 NoopChannel: suppressed notification for ${message.serviceName}/${message.workflowId}`);
    console.log(message.text);
    return { messageId, channel: this.id };
  }

  async startCallbackListener(
    _resolver: (data: CallbackData) => Promise<void>,
  ): Promise<() => void> {
    console.log("📭 NoopChannel: callback listener disabled");
    return () => {
      console.log("📭 NoopChannel: stopped");
    };
  }
}
