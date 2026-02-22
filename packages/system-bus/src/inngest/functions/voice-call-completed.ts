import { createHash } from "node:crypto";
import { inngest } from "../client";
import { emitMeasuredOtelEvent } from "../../observability/emit";

type VoiceCallCompletedData = {
  transcript?: unknown;
  room?: unknown;
  timestamp?: unknown;
  turns?: unknown;
  duration?: unknown;
  sessionId?: unknown;
};

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseCapturedAt(timestamp: unknown): string {
  if (typeof timestamp !== "string" || timestamp.trim().length === 0) {
    return new Date().toISOString();
  }

  const trimmed = timestamp.trim();
  const parsed = new Date(trimmed);
  if (Number.isFinite(parsed.getTime())) {
    return parsed.toISOString();
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})$/u.exec(trimmed);
  if (!match) return new Date().toISOString();

  const [, year, month, day, hour, minute, second] = match;
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
  const asDate = new Date(iso);
  if (Number.isFinite(asDate.getTime())) {
    return asDate.toISOString();
  }

  return new Date().toISOString();
}

function countMessages(transcript: string, turns: unknown): number {
  const turnsNumber = asFiniteNumber(turns);
  if (turnsNumber != null && turnsNumber > 0) {
    return Math.max(1, Math.floor(turnsNumber));
  }

  const blocks = transcript
    .split(/\n{2,}/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return Math.max(blocks.length, 1);
}

function countUserMessages(transcript: string): number {
  const markdownMatches = transcript.match(/\*\*Joel\*\*:/gu)?.length ?? 0;
  if (markdownMatches > 0) return markdownMatches;

  const plainMatches = transcript.match(/\bJoel:/gu)?.length ?? 0;
  if (plainMatches > 0) return plainMatches;

  return Math.max(1, Math.floor(countMessages(transcript, null) / 2));
}

function buildDedupeKey(parts: Array<string>): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("|");
  }
  return hash.digest("hex");
}

export const voiceCallCompleted = inngest.createFunction(
  {
    id: "voice-call-completed",
    name: "Voice Call Completed → Memory Session",
    concurrency: { limit: 1 },
    retries: 2,
  },
  { event: "voice/call.completed" },
  async ({ event, step }) => {
    const normalized = await step.run("normalize-payload", async () => {
      const data = (event.data ?? {}) as VoiceCallCompletedData;
      const transcript = typeof data.transcript === "string" ? data.transcript.trim() : "";
      if (!transcript) {
        return null;
      }

      const room = typeof data.room === "string" ? data.room.trim() : "voice";
      const rawTimestamp =
        typeof data.timestamp === "string" && data.timestamp.trim().length > 0
          ? data.timestamp.trim()
          : "";
      const capturedAt = parseCapturedAt(rawTimestamp);
      const sessionId =
        typeof data.sessionId === "string" && data.sessionId.trim().length > 0
          ? data.sessionId.trim()
          : `voice:${room}:${rawTimestamp || new Date(capturedAt).getTime()}`;
      const messageCount = countMessages(transcript, data.turns);
      const userMessageCount = countUserMessages(transcript);
      const duration = Math.max(0, Math.floor(asFiniteNumber(data.duration) ?? 0));
      const dedupeKey = buildDedupeKey([sessionId, room, transcript, rawTimestamp]);

      return {
        room,
        capturedAt,
        messageCount,
        userMessageCount,
        eventPayload: {
          name: "memory/session.ended" as const,
          data: {
            sessionId,
            dedupeKey,
            trigger: "shutdown" as const,
            messages: transcript,
            messageCount,
            userMessageCount,
            duration,
            sessionName: room ? `Voice call (${room})` : "Voice call",
            filesRead: [] as string[],
            filesModified: [] as string[],
            capturedAt,
            schemaVersion: 1 as const,
          },
        },
      };
    });

    if (!normalized) {
      return { forwarded: false, reason: "missing_transcript" };
    }

    await emitMeasuredOtelEvent(
      {
        level: "info",
        source: "worker",
        component: "voice-call-completed",
        action: "memory.session_ended.forwarded",
        metadata: {
          room: normalized.room,
          messageCount: normalized.messageCount,
          userMessageCount: normalized.userMessageCount,
        },
      },
      async () => {
        await step.sendEvent("emit-memory-session-ended", normalized.eventPayload);
      }
    );

    return {
      forwarded: true,
      room: normalized.room,
      messageCount: normalized.messageCount,
      userMessageCount: normalized.userMessageCount,
    };
  }
);
