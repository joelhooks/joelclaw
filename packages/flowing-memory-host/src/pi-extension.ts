import { homedir } from "node:os";
import path from "node:path";

import { decodeNativeEvent, FLOWING_MEMORY_INTERNAL_MARKER_V1 } from "./adapters.js";
import { submitNativeWake } from "./collector.js";
import {
  flushNativeRunCaptureQueue,
  scheduleNativeRunCapture,
} from "./raw-capture.js";

interface PiSessionManager {
  readonly getCwd: () => string;
  readonly getSessionFile: () => string | undefined;
  readonly getSessionId: () => string;
}

interface PiEventContext {
  readonly sessionManager: PiSessionManager;
}

interface PiExtensionApi {
  readonly on: (
    event: "session_start" | "session_shutdown" | "turn_end",
    handler: (event: unknown, context: PiEventContext) => void | Promise<void>,
  ) => void;
}

const spoolPath = () =>
  process.env.JOELCLAW_FLOWING_MEMORY_WAKE_SPOOL ??
  path.join(homedir(), ".joelclaw", "flowing-memory", "native-wakes.jsonl");

const enqueue = async (
  eventName: "session_start" | "session_shutdown" | "turn_end",
  context: PiEventContext,
) => {
  const transcriptPath = context.sessionManager.getSessionFile();
  if (transcriptPath === undefined) return;
  const decoded = decodeNativeEvent(
    "pi",
    {
      cwd: context.sessionManager.getCwd(),
      event_name: eventName,
      internal_marker:
        process.env.JOELCLAW_FLOWING_MEMORY_INTERNAL === "1"
          ? FLOWING_MEMORY_INTERNAL_MARKER_V1
          : undefined,
      occurred_at: new Date().toISOString(),
      session_id: context.sessionManager.getSessionId(),
      transcript_path: transcriptPath,
    },
    { captureInferenceSession: true },
  );
  if (decoded._tag !== "Accepted") return;

  // One installed extension owns both outputs. The local wake remains the only
  // semantic admission path; raw capture only posts immutable Runs for indexing.
  void scheduleNativeRunCapture(decoded.wake);
  await submitNativeWake({
    socketPath:
      process.env.JOELCLAW_FLOWING_MEMORY_COLLECTOR_SOCKET ??
      path.join(homedir(), ".joelclaw", "flowing-memory", "collector.sock"),
    spoolPath: spoolPath(),
    wake: decoded.wake,
  });
};

/** One hook owner fans out to flowing admission and immutable raw Run capture. */
export default function flowingMemoryPiExtension(pi: PiExtensionApi) {
  pi.on("session_start", (_event, context) => enqueue("session_start", context));
  pi.on("turn_end", (_event, context) => enqueue("turn_end", context));
  pi.on("session_shutdown", async (_event, context) => {
    await enqueue("session_shutdown", context).catch(() => undefined);
    await flushNativeRunCaptureQueue();
  });
}
