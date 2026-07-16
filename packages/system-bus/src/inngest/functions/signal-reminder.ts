import type { ChannelAuditSeed } from "@joelclaw/telemetry";
import { NonRetriableError } from "inngest";
import { getRedisClient } from "../../lib/redis";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";

// system-bus does not depend on @joelclaw/source-actions. Keep this compatibility
// bridge limited to its stable Redis wire fields until that package is wired here.
const ACTION_CALLBACK_PREFIX = "act:";
const ACTION_REGISTRY_KEY = "joelclaw:source-actions:registry:v1";
const ISO_TIMESTAMP_WITH_TIMEZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

type SourceKind =
  | "todoist"
  | "things"
  | "brain"
  | "front"
  | "gmail"
  | "inngest"
  | "fixture";

type SourceRef = {
  kind: SourceKind;
  id: string;
  revision?: string;
};

type ActionRecord = {
  actionId: string;
  sourceRef: SourceRef;
};

export type SignalReminderScheduledData = {
  actionId: string;
  remindAt: string;
  delivery: {
    text: string;
    channel?: string;
    audit?: ChannelAuditSeed;
  };
};

export type ReminderSourceSnapshot = {
  ref: SourceRef;
  state: "open" | "resolved";
  title: string;
  revision?: string;
  openUrl?: string;
};

export type SignalReminderOutcome = {
  actionId: string;
  remindAt: string;
  sourceRef: SourceRef;
  sourceRevision?: string;
  outcome: "suppressed-resolved" | "redelivered";
};

export type SignalReminderDependencies = {
  loadAction(actionId: string): Promise<ActionRecord>;
  inspectSource(ref: SourceRef): Promise<ReminderSourceSnapshot>;
  journalOutcome(outcome: SignalReminderOutcome): Promise<void>;
};

function isSourceKind(value: unknown): value is SourceKind {
  return (
    value === "todoist" ||
    value === "things" ||
    value === "brain" ||
    value === "front" ||
    value === "gmail" ||
    value === "inngest" ||
    value === "fixture"
  );
}

function parseSourceRef(value: unknown): SourceRef {
  if (!value || typeof value !== "object") throw new Error("action record has no sourceRef");
  const candidate = value as Record<string, unknown>;
  if (!isSourceKind(candidate.kind) || typeof candidate.id !== "string" || !candidate.id.trim()) {
    throw new Error("action record has an invalid sourceRef");
  }
  return {
    kind: candidate.kind,
    id: candidate.id,
    ...(typeof candidate.revision === "string" ? { revision: candidate.revision } : {}),
  };
}

export function parseSignalReminderActionRecord(raw: string, actionId: string): ActionRecord {
  const candidate = JSON.parse(raw) as Record<string, unknown>;
  if (candidate.actionId !== actionId) throw new Error("action registry ID does not match reminder");
  return { actionId, sourceRef: parseSourceRef(candidate.sourceRef) };
}

export function parseSignalReminderScheduledData(value: unknown): SignalReminderScheduledData {
  if (!value || typeof value !== "object") {
    throw new NonRetriableError("signal reminder data must be an object");
  }

  const candidate = value as Record<string, unknown>;
  const actionId = typeof candidate.actionId === "string" ? candidate.actionId.trim() : "";
  const remindAt = typeof candidate.remindAt === "string" ? candidate.remindAt.trim() : "";
  const delivery = candidate.delivery as Record<string, unknown> | undefined;
  const text = typeof delivery?.text === "string" ? delivery.text.trim() : "";

  if (!actionId.startsWith(ACTION_CALLBACK_PREFIX)) {
    throw new NonRetriableError("signal reminder actionId must use the act: prefix");
  }
  if (
    !ISO_TIMESTAMP_WITH_TIMEZONE.test(remindAt) ||
    !Number.isFinite(Date.parse(remindAt))
  ) {
    throw new NonRetriableError(
      "signal reminder remindAt must be an ISO timestamp with an explicit timezone",
    );
  }
  if (!text) throw new NonRetriableError("signal reminder delivery text is required");

  return {
    actionId,
    remindAt,
    delivery: {
      text,
      ...(typeof delivery?.channel === "string" ? { channel: delivery.channel } : {}),
      ...(delivery?.audit && typeof delivery.audit === "object"
        ? { audit: delivery.audit as ChannelAuditSeed }
        : {}),
    },
  };
}

async function loadAction(actionId: string): Promise<ActionRecord> {
  const raw = await getRedisClient().hget(ACTION_REGISTRY_KEY, actionId);
  if (!raw) throw new Error(`signal reminder action not found: ${actionId}`);
  return parseSignalReminderActionRecord(raw, actionId);
}

export function inspectBrainSource(ref: SourceRef): ReminderSourceSnapshot {
  const title = ref.id
    .split(/[-_/]+/u)
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
  return {
    ref,
    state: "open",
    title: title || ref.id,
    ...(ref.revision ? { revision: ref.revision, openUrl: ref.revision } : {}),
  };
}

async function inspectFrontSource(ref: SourceRef): Promise<ReminderSourceSnapshot> {
  const token = process.env.FRONT_API_TOKEN?.trim();
  if (!token) throw new Error("FRONT_API_TOKEN missing; cannot inspect reminder source");

  const { createFrontAdapter } = await import("@joelclaw/email");
  const email = createFrontAdapter({ apiToken: token });
  const { conversation } = await email.getConversation(ref.id);
  const revision = conversation.lastMessageAt.toISOString();
  return {
    ref: { ...ref, revision },
    state: conversation.status === "archived" ? "resolved" : "open",
    title: conversation.subject,
    revision,
  };
}

async function inspectSource(ref: SourceRef): Promise<ReminderSourceSnapshot> {
  switch (ref.kind) {
    case "brain":
      return inspectBrainSource(ref);
    case "front":
      return inspectFrontSource(ref);
    default:
      throw new Error(`no signal reminder source inspector registered for ${ref.kind}`);
  }
}

async function journalOutcome(outcome: SignalReminderOutcome): Promise<void> {
  await emitOtelEvent({
    level: "info",
    source: "worker",
    component: "signal-reminder",
    action: `signal.reminder.${outcome.outcome}`,
    success: true,
    metadata: {
      actionId: outcome.actionId,
      remindAt: outcome.remindAt,
      sourceKind: outcome.sourceRef.kind,
      sourceId: outcome.sourceRef.id,
      sourceRevision: outcome.sourceRevision,
      outcome: outcome.outcome,
    },
  });
}

const defaultDependencies: SignalReminderDependencies = {
  loadAction,
  inspectSource,
  journalOutcome,
};

export function createSignalReminderFunction(
  dependencies: SignalReminderDependencies = defaultDependencies,
) {
  return inngest.createFunction(
    {
      id: "signal/reminder",
      name: "Signal Reminder",
      idempotency: "event.data.actionId",
      cancelOn: [{ event: "signal/reminder.cancelled" as never, match: "data.actionId" }],
    },
    { event: "signal/reminder.scheduled" as never },
    async ({ event, step }) => {
      const reminder = parseSignalReminderScheduledData(event.data);

      await step.sleepUntil("sleep-until-reminder-due", new Date(reminder.remindAt));

      const action = await step.run("load-action-record", () =>
        dependencies.loadAction(reminder.actionId),
      );
      const source = await step.run("reinspect-source", () =>
        dependencies.inspectSource(action.sourceRef),
      );

      if (source.state === "resolved") {
        const outcome = {
          actionId: reminder.actionId,
          remindAt: reminder.remindAt,
          sourceRef: action.sourceRef,
          sourceRevision: source.revision,
          outcome: "suppressed-resolved" as const,
        };
        await step.run("journal-suppressed-reminder", () => dependencies.journalOutcome(outcome));
        return outcome;
      }

      await step.sendEvent("redeliver-reminder", {
        name: "gateway/send.message",
        data: {
          channel: reminder.delivery.channel ?? "telegram",
          text: reminder.delivery.text,
          // A snooze consumes its action ID. Reusing the captured keyboard would
          // render dead callbacks, so redelivery intentionally has no controls.
          audit: {
            ...reminder.delivery.audit,
            flowId: reminder.delivery.audit?.flowId ?? `signal-reminder:${reminder.actionId}`,
            producer: "signal/reminder",
            originSystemId: "system-bus",
            route: reminder.delivery.audit?.route ?? "signal-reminder.redelivery",
          },
        },
      });

      const outcome = {
        actionId: reminder.actionId,
        remindAt: reminder.remindAt,
        sourceRef: action.sourceRef,
        sourceRevision: source.revision,
        outcome: "redelivered" as const,
      };
      await step.run("journal-redelivered-reminder", () => dependencies.journalOutcome(outcome));
      return outcome;
    },
  );
}

export const signalReminder = createSignalReminderFunction();
