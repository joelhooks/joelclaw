/**
 * iMessage channel via imsg JSON-RPC socket daemon (ADR-0121).
 *
 * Architecture:
 *   - `imsg rpc --socket /tmp/imsg.sock` runs as a separate launchd service with FDA
 *   - Gateway connects to that socket, sends JSON-RPC requests, receives notifications
 *   - No FDA required for the gateway daemon itself
 */
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import net from "node:net";
import { emitGatewayOtel } from "@joelclaw/telemetry";
import type { EnqueueFn } from "./redis";
import type { Channel, ChannelPlatform, InboundMessage, MessageHandler, SendOptions } from "./types";

const SOCKET_PATH = process.env.IMSG_SOCKET_PATH ?? "/tmp/imsg.sock";
const IMESSAGE_USER_ID = typeof process.getuid === "function" ? process.getuid() : 0;
const IMSG_LAUNCHD_LABEL = process.env.IMSG_LAUNCHD_LABEL ?? `gui/${IMESSAGE_USER_ID}/com.joel.imsg-rpc`;
const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS = 5 * 60_000; // 5 minutes max backoff
const SEND_TIMEOUT_MS = 10_000;
const HEAL_COOLDOWN_MS = 60_000;

const execFileAsync = (command: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(command, args, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: string };
}

interface IMessagePayload {
  id?: number;
  chat_id?: number;
  text?: string;
  sender?: string;
  is_from_me?: boolean;
  created_at?: string;
  guid?: string;
}

export class IMessageChannel implements Channel {
  readonly platform: ChannelPlatform = "imessage";

  private reconnectDelay = RECONNECT_BASE_MS;
  private reconnectAttempts = 0;
  private running = false;
  private stopRequested = false;
  private socket: net.Socket | undefined;
  private nextIdValue = 1;
  private pending = new Map<number, PendingRequest>();
  private messageHandler: MessageHandler | undefined;
  private lastHealAt = 0;
  private healing = false;

  constructor(private sender: string) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;

    void this.reconnectLoop().catch((err) => {
      console.error("[gateway:imessage] reconnect loop fatal", { error: String(err) });
    });

    console.log("[gateway:imessage] channel started", { socketPath: SOCKET_PATH, allowedSender: this.sender });
    void emitGatewayOtel({
      level: "info",
      component: "imessage-channel",
      action: "imessage.channel.started",
      success: true,
      metadata: { socketPath: SOCKET_PATH, allowedSender: this.sender },
    });
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.running = false;
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
      this.socket = undefined;
    }
    console.log("[gateway:imessage] stopped");
    void emitGatewayOtel({
      level: "info",
      component: "imessage-channel",
      action: "imessage.channel.stopped",
      success: true,
    });
  }

  /**
   * Send an iMessage via JSON-RPC send method.
   */
  async send(target: string, text: string, _options?: SendOptions): Promise<void> {
    if (!this.socket || this.socket.destroyed) {
      console.error("[gateway:imessage] not connected, can't send");
      void emitGatewayOtel({
        level: "error",
        component: "imessage-channel",
        action: "imessage.send.not_connected",
        success: false,
        metadata: { to: target },
      });
      return;
    }

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
        await this.sendRequest(this.socket, "send", { to: target, text: chunk });
      } catch (err) {
        console.error("[gateway:imessage] send failed", { to: target, error: String(err) });
        void emitGatewayOtel({
          level: "error",
          component: "imessage-channel",
          action: "imessage.send.failed",
          success: false,
          error: String(err),
          metadata: { to: target },
        });
        return;
      }
    }

    void emitGatewayOtel({
      level: "info",
      component: "imessage-channel",
      action: "imessage.send.completed",
      success: true,
      metadata: { to: target, chunks: chunks.length },
    });
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  get isRunning(): boolean {
    return this.running;
  }

  private async connectAndRun(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(SOCKET_PATH);
      this.socket = socket;
      let buffer = "";
      let connected = false;

      socket.on("connect", async () => {
        connected = true;
        console.log("[gateway:imessage] connected to imsg-rpc socket");
        void emitGatewayOtel({
          level: "info",
          component: "imessage-channel",
          action: "imessage.socket.connected",
          success: true,
        });

        try {
          // Subscribe to all incoming messages
          const params: Record<string, unknown> = { attachments: false };
          if (this.sender) params.participants = [this.sender];

          await this.sendRequest(socket, "watch.subscribe", params);
          console.log("[gateway:imessage] watch.subscribe OK");
        } catch (err) {
          console.error("[gateway:imessage] watch.subscribe failed", { error: String(err) });
          socket.destroy();
        }
      });

      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let parsed: JsonRpcResponse | JsonRpcNotification;
          try {
            parsed = JSON.parse(trimmed) as JsonRpcResponse | JsonRpcNotification;
          } catch {
            console.warn("[gateway:imessage] non-JSON from socket", { line: trimmed });
            continue;
          }

          // Response to a pending request
          if ("id" in parsed && parsed.id != null) {
            const entry = this.pending.get(parsed.id);
            if (entry) {
              clearTimeout(entry.timer);
              this.pending.delete(parsed.id);
              const resp = parsed as JsonRpcResponse;
              if (resp.error) {
                entry.reject(new Error(`RPC error ${resp.error.code}: ${resp.error.message}`));
              } else {
                entry.resolve(resp.result);
              }
            }
            continue;
          }

          if ("method" in parsed) {
            // Notification
            void this.handleNotification(parsed as JsonRpcNotification);
          }
        }
      });

      socket.on("error", (err) => {
        if (!this.stopRequested) {
          console.error("[gateway:imessage] socket error", { error: err.message });
          void emitGatewayOtel({
            level: "error",
            component: "imessage-channel",
            action: "imessage.socket.error",
            success: false,
            error: err.message,
          });

          if (err.message.includes("ENOENT")) {
            void this.maybeHealSocket("socket-enoent");
          }
        }
      });

      socket.on("close", () => {
        this.socket = undefined;
        // Reject all pending
        for (const [id, entry] of this.pending) {
          clearTimeout(entry.timer);
          entry.reject(new Error("socket closed"));
          this.pending.delete(id);
        }
        if (connected) {
          resolve(); // was connected, clean disconnect → resolve (resets backoff)
        } else {
          reject(new Error("socket closed before connecting")); // never connected → reject (keeps backoff)
        }
      });
    });
  }

  private async reconnectLoop(): Promise<void> {
    while (!this.stopRequested) {
      try {
        await this.maybeHealSocket("reconnect-loop");
        await this.connectAndRun();
        // If we successfully connected, reset backoff
        this.reconnectDelay = RECONNECT_BASE_MS;
        this.reconnectAttempts = 0;
      } catch (err) {
        if (!this.stopRequested) {
          this.reconnectAttempts += 1;
          // Only log first failure and then every 10th attempt to avoid log spam
          if (this.reconnectAttempts === 1 || this.reconnectAttempts % 10 === 0) {
            console.error("[gateway:imessage] connection error", {
              error: String(err),
              attempt: this.reconnectAttempts,
              nextDelayMs: this.reconnectDelay,
            });
          }
        }
      }

      if (!this.stopRequested) {
        if (this.reconnectAttempts <= 1 || this.reconnectAttempts % 10 === 0) {
          console.log(
            `[gateway:imessage] reconnecting in ${Math.round(this.reconnectDelay / 1000)}s (attempt ${this.reconnectAttempts})`
          );
          void emitGatewayOtel({
            level: this.reconnectAttempts <= 3 ? "warn" : "info",
            component: "imessage-channel",
            action: "imessage.socket.reconnecting",
            success: false,
            metadata: { attempt: this.reconnectAttempts, delayMs: this.reconnectDelay },
          });
        }
        await new Promise((r) => setTimeout(r, this.reconnectDelay));
        // Exponential backoff: 5s → 10s → 20s → 40s → ... → 5min max
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
      }
    }
  }

  private async maybeHealSocket(reason: string): Promise<void> {
    if (this.stopRequested) return;

    const now = Date.now();
    if (this.healing || now - this.lastHealAt < HEAL_COOLDOWN_MS) {
      return;
    }

    try {
      await access(SOCKET_PATH);
      return;
    } catch {
      // missing socket path — continue with heal attempt
    }

    this.healing = true;
    this.lastHealAt = now;

    console.warn("[gateway:imessage] socket missing, attempting launchd heal", {
      reason,
      socketPath: SOCKET_PATH,
      launchdLabel: IMSG_LAUNCHD_LABEL,
    });
    void emitGatewayOtel({
      level: "warn",
      component: "imessage-channel",
      action: "imessage.socket.heal.attempt",
      success: false,
      metadata: {
        reason,
        socketPath: SOCKET_PATH,
        launchdLabel: IMSG_LAUNCHD_LABEL,
      },
    });

    try {
      await execFileAsync("launchctl", ["kickstart", "-k", IMSG_LAUNCHD_LABEL]);
      void emitGatewayOtel({
        level: "info",
        component: "imessage-channel",
        action: "imessage.socket.heal.success",
        success: true,
        metadata: {
          reason,
          socketPath: SOCKET_PATH,
          launchdLabel: IMSG_LAUNCHD_LABEL,
        },
      });
    } catch (error) {
      console.error("[gateway:imessage] launchd heal failed", {
        reason,
        error: String(error),
        launchdLabel: IMSG_LAUNCHD_LABEL,
      });
      void emitGatewayOtel({
        level: "error",
        component: "imessage-channel",
        action: "imessage.socket.heal.failed",
        success: false,
        error: String(error),
        metadata: {
          reason,
          socketPath: SOCKET_PATH,
          launchdLabel: IMSG_LAUNCHD_LABEL,
        },
      });
    } finally {
      this.healing = false;
    }
  }

  private async handleNotification(notif: JsonRpcNotification): Promise<void> {
    if (notif.method !== "message") return;

    const params = notif.params as { subscription?: number; message?: IMessagePayload };
    const msg = params?.message;
    if (!msg) return;
    if (msg.is_from_me) return;
    if (!msg.text?.trim()) return;
    if (!msg.sender) return;

    if (this.sender && msg.sender.toLowerCase() !== this.sender.toLowerCase()) {
      console.debug("[gateway:imessage] message from non-allowed sender", { sender: msg.sender });
      return;
    }

    const chatId = msg.chat_id ?? 0;
    const text = msg.text.trim();
    const inbound: InboundMessage = {
      source: "imessage",
      prompt: text,
      metadata: {
        imessageChatId: chatId,
        imessageMessageId: msg.id,
        imessageSender: msg.sender,
        imessageGuid: msg.guid,
      },
    };

    console.log("[gateway:imessage] message received", { chatId, sender: msg.sender, length: text.length });
    void emitGatewayOtel({
      level: "info",
      component: "imessage-channel",
      action: "imessage.message.received",
      success: true,
      metadata: { chatId, sender: msg.sender, length: text.length },
    });

    if (!this.messageHandler) return;
    void this.messageHandler(inbound);
  }

  private sendRequest(socket: net.Socket, method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextRequestId();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, SEND_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      const msg = JSON.stringify({ jsonrpc: "2.0", method, params, id }) + "\n";
      socket.write(msg);
    });
  }

  private nextRequestId(): number {
    return this.nextIdValue++;
  }
}

export function parseChatId(source: string): number | undefined {
  const match = source.match(/^imessage:(\d+)$/);
  return match?.[1] ? parseInt(match[1], 10) : undefined;
}

let defaultInstance: IMessageChannel | undefined;

export async function start(sender: string, enqueue: EnqueueFn): Promise<void> {
  if (!defaultInstance || !defaultInstance.isRunning) {
    defaultInstance = new IMessageChannel(sender);
  }

  defaultInstance.onMessage((message) => {
    const metadataChatId = message.metadata?.imessageChatId;
    const chatId = typeof metadataChatId === "number" ? metadataChatId : undefined;
    return enqueue(`imessage:${chatId ?? ""}`, message.prompt, message.metadata);
  });
  await defaultInstance.start();
}

export async function send(to: string, text: string): Promise<void> {
  if (!defaultInstance) {
    defaultInstance = new IMessageChannel(process.env.IMESSAGE_ALLOWED_SENDER ?? "");
  }
  await defaultInstance.send(to, text);
}

export async function shutdown(): Promise<void> {
  if (!defaultInstance) return;
  await defaultInstance.stop();
  defaultInstance = undefined;
}
