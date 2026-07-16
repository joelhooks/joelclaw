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

export const FIXTURE_SOURCE_REFS = {
  safeDone: { kind: "fixture", id: "safe-done" },
  acknowledgeOnly: { kind: "fixture", id: "acknowledge-only" },
  snoozable: { kind: "fixture", id: "snoozable" },
  urlOnly: { kind: "fixture", id: "url-only" },
} as const satisfies Record<string, SourceRef>;

type FixtureRecord = {
  item: SourceItem;
  capabilities: SourceCapabilities;
  mutationCount: number;
  acknowledgedActionIds: Set<string>;
  snoozedUntilByActionId: Map<string, string>;
};

export interface FixtureSourceAdapter extends SourceAdapter {
  readonly mutationCount: (sourceId: string) => number;
  readonly wasAcknowledged: (actionId: string) => boolean;
  readonly snoozedUntil: (actionId: string) => string | undefined;
}

const unsupported = (
  operation: SourceError["operation"],
  item: SourceItem,
  message: string,
) => new SourceError({ operation, ref: item.ref, message });

export function makeFixtureSourceAdapter(): FixtureSourceAdapter {
  const records = new Map<string, FixtureRecord>([
    [
      FIXTURE_SOURCE_REFS.safeDone.id,
      {
        item: {
          ref: FIXTURE_SOURCE_REFS.safeDone,
          title: "Ship the safe fixture change",
          state: "open",
          semanticAction: "complete",
          revision: "1",
        },
        capabilities: {
          resolve: { supported: true, idempotency: "read-before-write", button: "Done" },
          acknowledge: true,
          snooze: { supported: false, mode: "none" },
          openUrl: false,
        },
        mutationCount: 0,
        acknowledgedActionIds: new Set(),
        snoozedUntilByActionId: new Map(),
      },
    ],
    [
      FIXTURE_SOURCE_REFS.acknowledgeOnly.id,
      {
        item: {
          ref: FIXTURE_SOURCE_REFS.acknowledgeOnly,
          title: "Review the acknowledge-only fixture",
          state: "open",
          semanticAction: "acknowledge",
          revision: "1",
        },
        capabilities: {
          resolve: { supported: false, idempotency: "none", button: "Acknowledge" },
          acknowledge: true,
          snooze: { supported: false, mode: "none" },
          openUrl: false,
        },
        mutationCount: 0,
        acknowledgedActionIds: new Set(),
        snoozedUntilByActionId: new Map(),
      },
    ],
    [
      FIXTURE_SOURCE_REFS.snoozable.id,
      {
        item: {
          ref: FIXTURE_SOURCE_REFS.snoozable,
          title: "Remind me about the snoozable fixture",
          state: "open",
          semanticAction: "acknowledge",
          revision: "1",
        },
        capabilities: {
          resolve: { supported: false, idempotency: "none", button: "Acknowledge" },
          acknowledge: true,
          snooze: { supported: true, mode: "local-reminder" },
          openUrl: false,
        },
        mutationCount: 0,
        acknowledgedActionIds: new Set(),
        snoozedUntilByActionId: new Map(),
      },
    ],
    [
      FIXTURE_SOURCE_REFS.urlOnly.id,
      {
        item: {
          ref: FIXTURE_SOURCE_REFS.urlOnly,
          title: "Open the fixture source",
          state: "open",
          semanticAction: "none",
          revision: "1",
          openUrl: "https://example.com/source-actions/url-only",
        },
        capabilities: {
          resolve: { supported: false, idempotency: "none", button: "Acknowledge" },
          acknowledge: false,
          snooze: { supported: false, mode: "none" },
          openUrl: true,
        },
        mutationCount: 0,
        acknowledgedActionIds: new Set(),
        snoozedUntilByActionId: new Map(),
      },
    ],
  ]);

  const inspect = Effect.fn("FixtureSourceAdapter.inspect")(function* (ref: SourceRef) {
    const record = records.get(ref.id);
    if (ref.kind !== "fixture" || !record) {
      return yield* Effect.fail(
        new SourceError({ operation: "inspect", ref, message: `Fixture item not found: ${ref.id}` }),
      );
    }
    return { ...record.item, ref: { ...record.item.ref } };
  });

  const capabilities = (item: SourceItem): SourceCapabilities => {
    const record = records.get(item.ref.id);
    if (!record) {
      return {
        resolve: { supported: false, idempotency: "none", button: "Acknowledge" },
        acknowledge: false,
        snooze: { supported: false, mode: "none" },
        openUrl: false,
      };
    }
    return record.capabilities;
  };

  const resolve = Effect.fn("FixtureSourceAdapter.resolve")(function* (
    item: SourceItem,
    _context: ActionContext,
  ) {
    const current = yield* inspect(item.ref);
    const record = records.get(item.ref.id);
    if (!record || !capabilities(current).resolve.supported) {
      return yield* Effect.fail(unsupported("resolve", item, "Resolve is not supported for this item"));
    }
    if (current.state === "resolved") {
      return {
        outcome: "already-applied" as const,
        sourceId: item.ref.id,
        sourceRevision: current.revision,
        detail: "Fixture item was already resolved",
      };
    }

    record.mutationCount += 1;
    const nextRevision = String(Number(current.revision ?? "0") + 1);
    record.item = { ...current, state: "resolved", revision: nextRevision };

    const after = yield* inspect(item.ref);
    if (after.state !== "resolved") {
      return yield* Effect.fail(
        new SourceError({
          operation: "resolve",
          ref: after.ref,
          message: "Fixture mutation returned without resolved readback",
        }),
      );
    }

    return {
      outcome: "applied" as const,
      sourceId: item.ref.id,
      sourceRevision: after.revision,
      detail: "Fixture item resolved and read back",
    };
  });

  const acknowledge = Effect.fn("FixtureSourceAdapter.acknowledge")(function* (
    item: SourceItem,
    context: ActionContext,
  ) {
    const record = records.get(item.ref.id);
    if (!record || !capabilities(item).acknowledge) {
      return yield* Effect.fail(
        unsupported("acknowledge", item, "Acknowledge is not supported for this item"),
      );
    }
    const alreadyApplied = record.acknowledgedActionIds.has(context.actionId);
    record.acknowledgedActionIds.add(context.actionId);
    return {
      outcome: alreadyApplied ? ("already-applied" as const) : ("applied" as const),
      sourceId: item.ref.id,
      sourceRevision: item.revision,
      detail: alreadyApplied ? "Interaction was already acknowledged" : "Interaction acknowledged",
    };
  });

  const snooze = Effect.fn("FixtureSourceAdapter.snooze")(function* (
    item: SourceItem,
    until: Date,
    context: ActionContext,
  ) {
    const record = records.get(item.ref.id);
    if (!record || !capabilities(item).snooze.supported) {
      return yield* Effect.fail(unsupported("snooze", item, "Snooze is not supported for this item"));
    }
    const nextUntil = until.toISOString();
    const previousUntil = record.snoozedUntilByActionId.get(context.actionId);
    record.snoozedUntilByActionId.set(context.actionId, nextUntil);
    return {
      outcome: previousUntil === nextUntil ? ("already-applied" as const) : ("applied" as const),
      sourceId: item.ref.id,
      sourceRevision: item.revision,
      detail: `Interaction snoozed until ${nextUntil}`,
    };
  });

  const openUrl = Effect.fn("FixtureSourceAdapter.openUrl")(function* (item: SourceItem) {
    return item.openUrl ? Option.some(item.openUrl) : Option.none<string>();
  });

  return {
    inspect,
    capabilities,
    resolve,
    acknowledge,
    snooze,
    openUrl,
    mutationCount: (sourceId) => records.get(sourceId)?.mutationCount ?? 0,
    wasAcknowledged: (actionId) =>
      [...records.values()].some((record) => record.acknowledgedActionIds.has(actionId)),
    snoozedUntil: (actionId) => {
      for (const record of records.values()) {
        const until = record.snoozedUntilByActionId.get(actionId);
        if (until) return until;
      }
      return undefined;
    },
  };
}
