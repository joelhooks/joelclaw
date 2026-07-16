import { Effect, Option } from "effect";
import type {
  ActionContext,
  MutationReceipt,
  SourceAdapter,
  SourceCapabilities,
  SourceItem,
  SourceRef,
} from "../types";
import { SourceError } from "../types";

export type SignalReminderScheduledEvent = {
  name: "signal/reminder.scheduled";
  data: {
    actionId: string;
    remindAt: string;
    delivery: {
      text: string;
      channel: "telegram";
    };
  };
};

export type EmitReminder = (event: SignalReminderScheduledEvent) => Promise<void>;

export type BrainReminderSourceAdapterOptions = {
  slug: string;
  title: string;
  openUrl: string;
  emitReminder: EmitReminder;
};

export interface BrainReminderSourceAdapter extends SourceAdapter {
  readonly sourceRef: SourceRef & { kind: "brain" };
  readonly wasAcknowledged: (actionId: string) => boolean;
  readonly scheduledReminder: (actionId: string) => SignalReminderScheduledEvent | undefined;
}

const capabilities: SourceCapabilities = {
  resolve: { supported: false, idempotency: "none", button: "Acknowledge" },
  acknowledge: true,
  snooze: { supported: true, mode: "local-reminder" },
  openUrl: true,
};

function sourceError(
  operation: SourceError["operation"],
  ref: SourceRef,
  message: string,
  cause?: unknown,
): SourceError {
  return new SourceError({ operation, ref, message, ...(cause === undefined ? {} : { cause }) });
}

/**
 * Curated Brain memories have no mutable resolved state. This adapter keeps
 * acknowledgement local and delegates snooze durability through an injected
 * reminder event port.
 */
export function makeBrainReminderSourceAdapter(
  options: BrainReminderSourceAdapterOptions,
): BrainReminderSourceAdapter {
  const sourceRef = {
    kind: "brain",
    id: options.slug,
    revision: options.openUrl,
  } as const satisfies SourceRef;
  const acknowledgedActionIds = new Set<string>();
  const remindersByActionId = new Map<string, SignalReminderScheduledEvent>();

  const isItem = (item: SourceItem): boolean =>
    item.ref.kind === sourceRef.kind && item.ref.id === sourceRef.id;

  const inspect = Effect.fn("BrainReminderSourceAdapter.inspect")(function* (ref: SourceRef) {
    if (ref.kind !== "brain" || ref.id !== sourceRef.id) {
      return yield* Effect.fail(
        sourceError("inspect", ref, `Brain memory not found: ${ref.id}`),
      );
    }
    return {
      ref: sourceRef,
      title: options.title,
      state: "open" as const,
      semanticAction: "acknowledge" as const,
      revision: options.openUrl,
      openUrl: options.openUrl,
    };
  });

  const resolve = Effect.fn("BrainReminderSourceAdapter.resolve")(function* (
    item: SourceItem,
    _context: ActionContext,
  ) {
    return yield* Effect.fail(
      sourceError(
        "resolve",
        item.ref,
        "Brain memories cannot be resolved at the source; acknowledge the interaction instead",
      ),
    );
  });

  const acknowledge = Effect.fn("BrainReminderSourceAdapter.acknowledge")(function* (
    item: SourceItem,
    context: ActionContext,
  ) {
    if (!isItem(item)) {
      return yield* Effect.fail(
        sourceError("acknowledge", item.ref, "Acknowledge is not supported for this item"),
      );
    }
    const alreadyApplied = acknowledgedActionIds.has(context.actionId);
    acknowledgedActionIds.add(context.actionId);
    return {
      outcome: alreadyApplied ? ("already-applied" as const) : ("applied" as const),
      sourceId: sourceRef.id,
      sourceRevision: options.openUrl,
      openUrl: options.openUrl,
      detail: alreadyApplied
        ? "Memory interaction was already acknowledged"
        : "Memory interaction acknowledged",
    } satisfies MutationReceipt;
  });

  const snooze = Effect.fn("BrainReminderSourceAdapter.snooze")(function* (
    item: SourceItem,
    until: Date,
    context: ActionContext,
  ) {
    if (!isItem(item)) {
      return yield* Effect.fail(
        sourceError("snooze", item.ref, "Snooze is not supported for this item"),
      );
    }
    if (!Number.isFinite(until.getTime())) {
      return yield* Effect.fail(
        sourceError("snooze", item.ref, "Snooze requires a valid reminder time"),
      );
    }

    const remindAt = until.toISOString();
    const existing = remindersByActionId.get(context.actionId);
    if (existing?.data.remindAt === remindAt) {
      return {
        outcome: "already-applied" as const,
        sourceId: sourceRef.id,
        sourceRevision: options.openUrl,
        openUrl: options.openUrl,
        detail: `Memory reminder was already scheduled for ${remindAt}`,
      } satisfies MutationReceipt;
    }

    const event: SignalReminderScheduledEvent = {
      name: "signal/reminder.scheduled",
      data: {
        actionId: context.actionId,
        remindAt,
        delivery: {
          text: `Yo — ${item.title} is back on your radar.`,
          channel: "telegram",
        },
      },
    };

    yield* Effect.tryPromise({
      try: () => options.emitReminder(event),
      catch: (cause) =>
        sourceError("snooze", item.ref, "Failed to schedule the memory reminder", cause),
    });
    remindersByActionId.set(context.actionId, event);

    return {
      outcome: "applied" as const,
      sourceId: sourceRef.id,
      sourceRevision: options.openUrl,
      openUrl: options.openUrl,
      detail: `Memory reminder scheduled for ${remindAt}`,
    } satisfies MutationReceipt;
  });

  const openUrl = Effect.fn("BrainReminderSourceAdapter.openUrl")(function* (item: SourceItem) {
    return isItem(item) ? Option.some(options.openUrl) : Option.none<string>();
  });

  return {
    sourceRef,
    inspect,
    capabilities: (item) =>
      isItem(item)
        ? capabilities
        : {
            resolve: { supported: false, idempotency: "none", button: "Acknowledge" },
            acknowledge: false,
            snooze: { supported: false, mode: "none" },
            openUrl: false,
          },
    resolve,
    acknowledge,
    snooze,
    openUrl,
    wasAcknowledged: (actionId) => acknowledgedActionIds.has(actionId),
    scheduledReminder: (actionId) => remindersByActionId.get(actionId),
  };
}
