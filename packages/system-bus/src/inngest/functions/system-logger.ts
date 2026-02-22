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
    { event: "pipeline/transcript.processed" },
    { event: "content/summarized" },
    { event: "pipeline/book.downloaded" },
    { event: "system/log.written" },
  ],
  async ({ event, step }) => {
    const logPath = `${VAULT}/system/system-log.jsonl`;

    // Normalize to canonical flat format
    const data = event.data as Record<string, unknown>;
    const eventParts = event.name.split("/");
    const action =
      (data.action as string) ??
      eventParts.pop()?.replace(".", "-") ??
      "unknown";
    const tool = (data.tool as string) ?? eventParts[0] ?? "unknown";
    const detail = (data.detail as string) ?? JSON.stringify(data);
    const reason = typeof data.reason === "string" ? data.reason : undefined;
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      action,
      tool,
      detail,
      ...(reason ? { reason } : {}),
    });

    await step.run("append-log", async () => {
      await Bun.write(
        Bun.file(logPath),
        (await Bun.file(logPath).text()) + entry + "\n"
      );
    });

    if (event.name !== "system/log.written") {
      await step.sendEvent("emit-system-log-written", {
        name: "system/log.written",
        data: {
          action,
          tool,
          detail,
          ...(reason ? { reason } : {}),
        },
      });
    }

    return { logged: event.name };
  }
);
