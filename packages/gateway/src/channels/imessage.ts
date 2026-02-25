/**
 * iMessage channel via imsg JSON-RPC socket daemon (ADR-0121).
 *
 * Architecture:
 *   - `imsg rpc --socket /tmp/imsg.sock` runs as a separate launchd service with FDA
 *   - Gateway connects to that socket, sends JSON-RPC requests, receives notifications
 *   - No FDA required for the gateway daemon itself
 */
import net from "node:net";
import { emitGatewayOtel } from "../observability";
import type { EnqueueFn } from "./redis";

const SOCKET_PATH = process.env.IMSG_SOCKET_PATH ?? "/tmp/imsg.sock";
const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS = 5 * 60_000; // 5 minutes max backoff
const SEND_TIMEOUT_MS = 10_000;
let reconnectDelay = RECONNECT_BASE_MS;
let reconnectAttempts = 0;

let allowedSender: string | undefined;
let enqueuePrompt: EnqueueFn | undefined;
let running = false;
let stopRequested = false;
let _socket: net.Socket | undefined;
let _nextId = 1;
const _pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

function nextId(): number {
  return _nextId++;
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

function handleNotification(notif: JsonRpcNotification): void {
  if (notif.method !== "message") return;

  const params = notif.params as { subscription?: number; message?: IMessagePayload };
  const msg = params?.message;
  if (!msg) return;
  if (msg.is_from_me) return;
  if (!msg.text?.trim()) return;
  if (!msg.sender) return;

  if (allowedSender && msg.sender.toLowerCase() !== allowedSender.toLowerCase()) {
    console.debug("[gateway:imessage] message from non-allowed sender", { sender: msg.sender });
    return;
  }

  const chatId = msg.chat_id ?? 0;
  const source = `imessage:${chatId}`;
  const text = msg.text.trim();

  console.log("[gateway:imessage] message received", { chatId, sender: msg.sender, length: text.length });
  void emitGatewayOtel({
    level: "info",
    component: "imessage-channel",
    action: "imessage.message.received",
    success: true,
    metadata: { chatId, sender: msg.sender, length: text.length },
  });

  enqueuePrompt!(source, text, {
    imessageChatId: chatId,
    imessageMessageId: msg.id,
    imessageSender: msg.sender,
    imessageGuid: msg.guid,
  });
}

function sendRequest(socket: net.Socket, method: string, params: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = nextId();
    const timer = setTimeout(() => {
      _pending.delete(id);
      reject(new Error(`RPC timeout: ${method}`));
    }, SEND_TIMEOUT_MS);

    _pending.set(id, { resolve, reject, timer });
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params, id }) + "\n";
    socket.write(msg);
  });
}

async function connectAndRun(): Promise<void> {
  return new Promise<void>((resolve) => {
    const socket = net.createConnection(SOCKET_PATH);
    _socket = socket;
    let buffer = "";
    let subscribed = false;

    socket.on("connect", async () => {
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
        if (allowedSender) params.participants = [allowedSender];

        await sendRequest(socket, "watch.subscribe", params);
        subscribed = true;
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
          const entry = _pending.get(parsed.id as number);
          if (entry) {
            clearTimeout(entry.timer);
            _pending.delete(parsed.id as number);
            const resp = parsed as JsonRpcResponse;
            if (resp.error) {
              entry.reject(new Error(`RPC error ${resp.error.code}: ${resp.error.message}`));
            } else {
              entry.resolve(resp.result);
            }
          }
        } else if ("method" in parsed) {
          // Notification
          handleNotification(parsed as JsonRpcNotification);
        }
      }
    });

    socket.on("error", (err) => {
      if (!stopRequested) {
        console.error("[gateway:imessage] socket error", { error: err.message });
        void emitGatewayOtel({
          level: "error",
          component: "imessage-channel",
          action: "imessage.socket.error",
          success: false,
          error: err.message,
        });
      }
    });

    socket.on("close", () => {
      _socket = undefined;
      // Reject all pending
      for (const [id, entry] of _pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error("socket closed"));
        _pending.delete(id);
      }
      resolve(); // signal reconnect loop
    });
  });
}

async function reconnectLoop(): Promise<void> {
  while (!stopRequested) {
    try {
      await connectAndRun();
      // If we successfully connected, reset backoff
      reconnectDelay = RECONNECT_BASE_MS;
      reconnectAttempts = 0;
    } catch (err) {
      if (!stopRequested) {
        reconnectAttempts += 1;
        // Only log first failure and then every 10th attempt to avoid log spam
        if (reconnectAttempts === 1 || reconnectAttempts % 10 === 0) {
          console.error("[gateway:imessage] connection error", {
            error: String(err),
            attempt: reconnectAttempts,
            nextDelayMs: reconnectDelay,
          });
        }
      }
    }

    if (!stopRequested) {
      if (reconnectAttempts <= 1 || reconnectAttempts % 10 === 0) {
        console.log(`[gateway:imessage] reconnecting in ${Math.round(reconnectDelay / 1000)}s (attempt ${reconnectAttempts})`);
        void emitGatewayOtel({
          level: reconnectAttempts <= 3 ? "warn" : "info",
          component: "imessage-channel",
          action: "imessage.socket.reconnecting",
          success: false,
          metadata: { attempt: reconnectAttempts, delayMs: reconnectDelay },
        });
      }
      await new Promise((r) => setTimeout(r, reconnectDelay));
      // Exponential backoff: 5s → 10s → 20s → 40s → ... → 5min max
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    }
  }
}

export async function start(sender: string, enqueue: EnqueueFn): Promise<void> {
  if (running) return;
  running = true;
  stopRequested = false;
  allowedSender = sender;
  enqueuePrompt = enqueue;

  void reconnectLoop().catch((err) => {
    console.error("[gateway:imessage] reconnect loop fatal", { error: String(err) });
  });

  console.log("[gateway:imessage] channel started", { socketPath: SOCKET_PATH, allowedSender });
  void emitGatewayOtel({
    level: "info",
    component: "imessage-channel",
    action: "imessage.channel.started",
    success: true,
    metadata: { socketPath: SOCKET_PATH, allowedSender },
  });
}

/**
 * Send an iMessage via JSON-RPC send method.
 */
export async function send(to: string, text: string): Promise<void> {
  if (!_socket || _socket.destroyed) {
    console.error("[gateway:imessage] not connected, can't send");
    void emitGatewayOtel({
      level: "error",
      component: "imessage-channel",
      action: "imessage.send.not_connected",
      success: false,
      metadata: { to },
    });
    return;
  }

  // Chunk at 1000 chars — iMessage has no hard limit but long messages are jarring
  const CHUNK_MAX = 1000;
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= CHUNK_MAX) { chunks.push(remaining); break; }
    let splitAt = remaining.lastIndexOf("\n", CHUNK_MAX);
    if (splitAt < CHUNK_MAX * 0.5) splitAt = remaining.lastIndexOf(" ", CHUNK_MAX);
    if (splitAt < CHUNK_MAX * 0.3) splitAt = CHUNK_MAX;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    try {
      await sendRequest(_socket, "send", { to, text: chunk });
    } catch (err) {
      console.error("[gateway:imessage] send failed", { to, error: String(err) });
      void emitGatewayOtel({
        level: "error",
        component: "imessage-channel",
        action: "imessage.send.failed",
        success: false,
        error: String(err),
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

export function parseChatId(source: string): number | undefined {
  const match = source.match(/^imessage:(\d+)$/);
  return match?.[1] ? parseInt(match[1], 10) : undefined;
}

export async function shutdown(): Promise<void> {
  stopRequested = true;
  running = false;
  if (_socket && !_socket.destroyed) {
    _socket.destroy();
    _socket = undefined;
  }
  console.log("[gateway:imessage] stopped");
  void emitGatewayOtel({
    level: "info",
    component: "imessage-channel",
    action: "imessage.channel.stopped",
    success: true,
  });
}
