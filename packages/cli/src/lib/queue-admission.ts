import {
  Priority,
  type QueuePriorityLabel,
  type QueueTriageDecision,
  type QueueTriageMode,
} from "@joelclaw/queue";
import { loadConfig } from "../config";

const cfg = loadConfig();
const WORKER_URL = (process.env.INNGEST_WORKER_URL ?? cfg.workerUrl ?? "http://localhost:3111").replace(/\/+$/u, "");

export type QueueAdmissionClientInput = {
  name: string;
  data: Record<string, unknown>;
  source: string;
  eventId?: string;
  metadata?: Record<string, unknown>;
  priority?: Priority | QueuePriorityLabel;
};

export type QueueAdmissionClientResult = {
  streamId: string;
  eventId: string;
  priority: number;
  triageMode: QueueTriageMode;
  triage?: QueueTriageDecision;
};

function formatResponseError(value: unknown): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizePriority(value: QueueAdmissionClientInput["priority"]): QueuePriorityLabel | undefined {
  if (typeof value === "string") {
    const normalized = value.trim().toUpperCase();
    if (normalized === "P0" || normalized === "P1" || normalized === "P2" || normalized === "P3") {
      return normalized;
    }
    return undefined;
  }

  if (value === Priority.P0) return "P0";
  if (value === Priority.P1) return "P1";
  if (value === Priority.P2) return "P2";
  if (value === Priority.P3) return "P3";
  return undefined;
}

export async function enqueueQueueEventViaWorker(
  input: QueueAdmissionClientInput,
): Promise<QueueAdmissionClientResult> {
  const response = await fetch(`${WORKER_URL}/internal/queue/enqueue`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: input.name,
      data: input.data,
      source: input.source,
      eventId: input.eventId,
      metadata: input.metadata,
      priority: normalizePriority(input.priority),
    }),
  });

  const bodyText = await response.text();
  const body = (() => {
    if (!bodyText.trim()) {
      return { ok: false, error: `HTTP ${response.status}` };
    }

    try {
      return JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      return { ok: false, error: bodyText };
    }
  })();

  if (!response.ok || !body?.ok || !body.result) {
    const error = body && typeof body === "object" ? (body as Record<string, unknown>).error : body;
    throw new Error(`Queue admission failed (${response.status}): ${formatResponseError(error)}`);
  }

  return body.result as QueueAdmissionClientResult;
}

export const __queueAdmissionTestUtils = {
  formatResponseError,
  normalizePriority,
};
