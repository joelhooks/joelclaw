import { emitGatewayOtel } from "../observability";
import type { EnqueueFn } from "./redis";

const RESTART_DELAY_MS = 5_000;

let allowedSender: string | undefined;
let enqueuePrompt: EnqueueFn | undefined;
let running = false;
let stopRequested = false;

interface IMessageWatchEvent {
  id?: number;
  chat_id?: number;
  text?: string;
  sender?: string;
  is_from_me?: boolean;
  created_at?: string;
  guid?: string;
  attachments?: unknown[];
  reactions?: unknown[];
  destination_caller_id?: string;
}

async function watchLoop(): Promise<void> {
  while (!stopRequested) {
    let proc: ReturnType<typeof Bun.spawn> | undefined;

    try {
      proc = Bun.spawn(["imsg", "watch", "--json"], {
        stdout: "pipe",
        stderr: "pipe",
      });

      console.log("[gateway:imessage] watch process started", { pid: proc.pid });
      void emitGatewayOtel({
        level: "info",
        component: "imessage-channel",
        action: "imessage.watch.started",
        success: true,
        metadata: { pid: proc.pid },
      });

      const stdout = proc.stdout;
      if (!stdout || typeof stdout === "number") {
        throw new Error("imsg watch stdout not available");
      }

      const decoder = new TextDecoder();
      let buffer = "";

      for await (const chunk of stdout as unknown as AsyncIterable<Uint8Array>) {
        if (stopRequested) break;

        buffer += decoder.decode(chunk, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const event = JSON.parse(trimmed) as IMessageWatchEvent;
            handleEvent(event);
          } catch {
            // not JSON — debug log only
            console.debug("[gateway:imessage] non-JSON line", { line: trimmed });
          }
        }
      }
    } catch (error) {
      if (!stopRequested) {
        console.error("[gateway:imessage] watch process error", { error: String(error) });
        void emitGatewayOtel({
          level: "error",
          component: "imessage-channel",
          action: "imessage.watch.error",
          success: false,
          error: String(error),
        });
      }
    } finally {
      proc?.kill();
    }

    if (!stopRequested) {
      console.log("[gateway:imessage] restarting watch in", RESTART_DELAY_MS, "ms");
      void emitGatewayOtel({
        level: "warn",
        component: "imessage-channel",
        action: "imessage.watch.restarting",
        success: false,
      });
      await new Promise((r) => setTimeout(r, RESTART_DELAY_MS));
    }
  }
}

function handleEvent(event: IMessageWatchEvent): void {
  // Only handle inbound messages (not sent by us)
  if (event.is_from_me) return;
  if (!event.text?.trim()) return;
  if (!event.sender) return;

  // Filter to allowed sender only
  if (
    allowedSender &&
    event.sender.toLowerCase() !== allowedSender.toLowerCase()
  ) {
    console.debug("[gateway:imessage] message from non-allowed sender", {
      sender: event.sender,
    });
    return;
  }

  const chatId = event.chat_id ?? 0;
  const source = `imessage:${chatId}`;
  const text = event.text.trim();

  console.log("[gateway:imessage] message received", {
    chatId,
    sender: event.sender,
    length: text.length,
  });

  void emitGatewayOtel({
    level: "info",
    component: "imessage-channel",
    action: "imessage.message.received",
    success: true,
    metadata: {
      chatId,
      sender: event.sender,
      length: text.length,
    },
  });

  enqueuePrompt!(source, text, {
    imessageChatId: chatId,
    imessageMessageId: event.id,
    imessageSender: event.sender,
    imessageGuid: event.guid,
  });
}

export async function start(sender: string, enqueue: EnqueueFn): Promise<void> {
  if (running) return;
  running = true;
  stopRequested = false;
  allowedSender = sender;
  enqueuePrompt = enqueue;

  // Verify imsg is available
  try {
    const probe = Bun.spawnSync(["imsg", "--version"]);
    if (probe.exitCode !== 0) throw new Error("imsg not found");
  } catch {
    console.error("[gateway:imessage] imsg CLI not found — iMessage channel disabled");
    void emitGatewayOtel({
      level: "error",
      component: "imessage-channel",
      action: "imessage.channel.start_failed",
      success: false,
      error: "imsg_not_found",
    });
    running = false;
    return;
  }

  // Start watch loop in background — self-heals on crash
  void watchLoop().catch((error) => {
    console.error("[gateway:imessage] watch loop fatal", { error: String(error) });
  });

  console.log("[gateway:imessage] channel started", { allowedSender });
  void emitGatewayOtel({
    level: "info",
    component: "imessage-channel",
    action: "imessage.channel.started",
    success: true,
    metadata: { allowedSender },
  });
}

/**
 * Send an iMessage reply via imsg CLI.
 */
export async function send(to: string, text: string): Promise<void> {
  // Chunk at 1000 chars — iMessage has no hard limit but long messages are jarring
  const CHUNK_MAX = 1000;
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= CHUNK_MAX) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", CHUNK_MAX);
    if (splitAt < CHUNK_MAX * 0.5) splitAt = remaining.lastIndexOf(" ", CHUNK_MAX);
    if (splitAt < CHUNK_MAX * 0.3) splitAt = CHUNK_MAX;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    try {
      const proc = Bun.spawnSync(["imsg", "send", "--to", to, "--text", chunk]);
      if (proc.exitCode !== 0) {
        const stderr = new TextDecoder().decode(proc.stderr);
        console.error("[gateway:imessage] send failed", { to, stderr });
        void emitGatewayOtel({
          level: "error",
          component: "imessage-channel",
          action: "imessage.send.failed",
          success: false,
          error: stderr,
          metadata: { to },
        });
        return;
      }
    } catch (error) {
      console.error("[gateway:imessage] send error", { to, error: String(error) });
      void emitGatewayOtel({
        level: "error",
        component: "imessage-channel",
        action: "imessage.send.error",
        success: false,
        error: String(error),
        metadata: { to },
      });
      return;
    }
  }

  void emitGatewayOtel({
    level: "info",
    component: "imessage-channel",
    action: "imessage.send.completed",
    success: true,
    metadata: { to, chunks: chunks.length },
  });
}

/**
 * Parse sender handle from imessage source string like "imessage:2"
 * Returns the chat_id. Outbound needs the original sender handle — pass it from metadata.
 */
export function parseChatId(source: string): number | undefined {
  const match = source.match(/^imessage:(\d+)$/);
  return match?.[1] ? parseInt(match[1], 10) : undefined;
}

export async function shutdown(): Promise<void> {
  stopRequested = true;
  running = false;
  console.log("[gateway:imessage] stopped");
  void emitGatewayOtel({
    level: "info",
    component: "imessage-channel",
    action: "imessage.channel.stopped",
    success: true,
  });
}
