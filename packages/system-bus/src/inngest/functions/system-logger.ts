import { inngest } from "../client";

const VAULT = process.env.VAULT_PATH ?? `${process.env.HOME}/Vault`;

/**
 * Universal system logger — listens to pipeline completion events
 * and writes canonical {timestamp, action, tool, detail, reason?} entries
 * to system-log.jsonl. Compatible with `slog validate`.
 */
export const systemLogger = inngest.createFunction(
  { id: "system-logger" },
  [
    { event: "pipeline/video.downloaded" },
    { event: "pipeline/video.ingested" },
    { event: "pipeline/transcript.processed" },
    { event: "content/summarized" },
    { event: "pipeline/book.downloaded" },
    { event: "system/log" },
  ],
  async ({ event }) => {
    const logPath = `${VAULT}/system/system-log.jsonl`;

    // Normalize to canonical flat format
    const data = event.data as Record<string, unknown>;
    const eventParts = event.name.split("/");
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      action:
        (data.action as string) ??
        eventParts.pop()?.replace(".", "-") ??
        "unknown",
      tool: (data.tool as string) ?? eventParts[0] ?? "unknown",
      detail: (data.detail as string) ?? JSON.stringify(data),
      ...(data.reason ? { reason: data.reason } : {}),
    });

    await Bun.write(
      Bun.file(logPath),
      (await Bun.file(logPath).text()) + entry + "\n"
    );

    return { logged: event.name };
  }
);
