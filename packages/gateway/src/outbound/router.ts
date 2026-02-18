// Lazy reference to avoid static import binding pollution across test files.
// Updated at wireSession() call time via re-import so mock.module() takes effect.
let _commandQueueModule: { getCurrentSource?: () => string | undefined } = {};

const HEARTBEAT_SOURCE = "heartbeat";
const HEARTBEAT_OK = "HEARTBEAT_OK";

function filterHeartbeatResponse(response: unknown, context?: { source?: unknown }): boolean {
  const source = typeof context?.source === "string" ? context.source : undefined;
  if (source !== HEARTBEAT_SOURCE) return false;
  if (typeof response !== "string") return false;

  const trimmed = response.trim();
  if (trimmed === HEARTBEAT_OK) {
    console.log("[heartbeat] received HEARTBEAT_OK; suppressing outbound response routing");
    return true;
  }

  const hasOk = trimmed.startsWith(HEARTBEAT_OK) || trimmed.endsWith(HEARTBEAT_OK);
  if (hasOk) {
    const withoutOk = trimmed.replace(HEARTBEAT_OK, "").trim();
    if (withoutOk.length <= 300) {
      console.log("[heartbeat] received HEARTBEAT_OK; suppressing outbound response routing");
      return true;
    }
  }

  return false;
}

type SessionEvent = {
  type?: string;
  assistantMessageEvent?: {
    type?: string;
    delta?: string;
  };
  delta?: string;
  text?: string;
  message?: {
    type?: string;
    delta?: string;
    text?: string;
  };
};

type SessionLike = {
  subscribe: (listener: (event: any) => unknown) => unknown;
};

export type OutboundChannelHandler = {
  send: (message: string, context?: { source?: string }) => unknown | Promise<unknown>;
};

const channels = new Map<string, OutboundChannelHandler>();

function consoleSend(message: string): void {
  console.log(message);
}

function ensureDefaultChannels(): void {
  if (!channels.has("console")) {
    channels.set("console", { send: consoleSend });
  }
}

ensureDefaultChannels();

export function registerChannel(id: string, handler: OutboundChannelHandler): void {
  if (id === "console") {
    channels.set(id, {
      send: (message: string, context?: { source?: string }) => {
        consoleSend(message);
        return handler.send(message, context);
      },
    });
    return;
  }

  channels.set(id, handler);
}

function getTargetSource(fallback: string): string {
  const liveSource = _commandQueueModule.getCurrentSource?.();
  return typeof liveSource === "string" && liveSource.length > 0 ? liveSource : fallback;
}

function extractTextDelta(event: SessionEvent): string | undefined {
  const assistant = event.assistantMessageEvent;
  if (
    assistant?.type === "text_delta" &&
    typeof assistant.delta === "string" &&
    assistant.delta.length > 0
  ) {
    return assistant.delta;
  }

  if (typeof event.delta === "string" && event.delta.length > 0) return event.delta;
  if (typeof event.text === "string" && event.text.length > 0) return event.text;
  if (typeof event.message?.delta === "string" && event.message.delta.length > 0) return event.message.delta;
  if (typeof event.message?.text === "string" && event.message.text.length > 0) return event.message.text;

  return undefined;
}

function reportSendError(source: string, error: unknown): void {
  console.error("outbound-router: failed to send outbound response", {
    source,
    error,
  });
}

function routeResponse(source: string, message: string): void {
  if (!message.trim()) return;
  if (filterHeartbeatResponse(message, { source })) return;

  ensureDefaultChannels();

  // Match exact source first, then prefix (e.g. "telegram:12345" → "telegram")
  let target = channels.get(source);
  if (!target) {
    const prefix = source.split(":")[0];
    if (prefix) target = channels.get(prefix);
  }
  if (!target) target = channels.get("console");
  if (!target) return;

  try {
    const maybePromise = target.send(message, { source });
    if (maybePromise && typeof (maybePromise as PromiseLike<unknown>).then === "function") {
      void (maybePromise as PromiseLike<unknown>).then(undefined, (error: unknown) => {
        reportSendError(source, error);
      });
    }
  } catch (error) {
    reportSendError(source, error);
  }
}

export async function wireSession(session: SessionLike): Promise<unknown> {
  // Refresh command-queue reference so mocks and reloads are observed reliably.
  // Try absolute URL import first, then common relative specifiers as fallback.
  const moduleCandidates = [
    new URL("../command-queue.ts", import.meta.url).href,
    "../command-queue",
    "../command-queue.ts",
  ];

  for (const specifier of moduleCandidates) {
    try {
      const mod = await import(specifier) as { getCurrentSource?: () => string | undefined };
      if (typeof mod.getCurrentSource === "function") {
        _commandQueueModule = mod;
        break;
      }
    } catch {}
  }

  ensureDefaultChannels();
  let activeSource = "console";
  let collecting = false;
  let chunks: string[] = [];

  const flush = (): void => {
    if (!collecting && chunks.length === 0) return;
    const text = chunks.join("");
    chunks = [];
    collecting = false;

    routeResponse(activeSource, text);
  };

  const startCollecting = (): void => {
    if (collecting && chunks.length > 0) {
      flush();
    }
    activeSource = getTargetSource("console");
    chunks = [];
    collecting = true;
  };

  return session.subscribe((event: SessionEvent) => {
    if (event.type === "message_start") {
      startCollecting();
      return;
    }

    const delta = extractTextDelta(event);
    if (delta) {
      if (!collecting) startCollecting();
      chunks.push(delta);
    }

    if (event.type === "message_end") {
      flush();
    }
  });
}

export default wireSession;
