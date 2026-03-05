/**
 * Console notification channel — fallback for testing without Telegram.
 *
 * Prints the message to stdout with instructions for CLI resolution.
 * Callback listener reads from stdin.
 */

import type {
  NotificationChannel,
  NotificationMessage,
  SendResult,
  CallbackData,
} from "./types";
import { createInterface } from "node:readline";

export class ConsoleChannel implements NotificationChannel {
  readonly id = "console";

  async send(message: NotificationMessage): Promise<SendResult> {
    const messageId = `console-${Date.now()}`;

    console.log(`\n${"═".repeat(60)}`);
    console.log(`📋 APPROVAL REQUEST`);
    console.log(`${"═".repeat(60)}`);
    console.log(message.text);
    console.log(`${"─".repeat(60)}`);
    console.log(`Actions:`);
    for (const action of message.actions) {
      console.log(`  → ${action.label} (value: "${action.value}")`);
    }
    console.log(`${"─".repeat(60)}`);
    console.log(`Workflow: ${message.serviceName}/${message.workflowId}`);
    console.log(`\nResolve via CLI:`);
    console.log(`  bun run resolve -- --id ${message.workflowId} --action approve`);
    console.log(`  bun run resolve -- --id ${message.workflowId} --action reject`);
    console.log(`\nOr type an action value here and press Enter:`);
    console.log(`${"═".repeat(60)}\n`);

    return { messageId, channel: this.id };
  }

  async startCallbackListener(
    resolver: (data: CallbackData) => Promise<void>,
  ): Promise<() => void> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    console.log(`⌨️  Console: listening for action input on stdin...`);

    rl.on("line", async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      // Parse "workflowId:action" or just "action" (uses last workflow)
      const parts = trimmed.split(":");
      const action = parts.length > 1 ? parts[1] : parts[0];
      const workflowId = parts.length > 1 ? parts[0] : "unknown";

      try {
        await resolver({
          serviceName: "approvalWorkflow",
          workflowId,
          action,
        });
      } catch (err) {
        console.error(`❌ Console: resolver failed:`, err);
      }
    });

    return () => {
      rl.close();
      console.log(`⌨️  Console: stopped listening`);
    };
  }
}
