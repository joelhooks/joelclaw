import type { EmailConversation, EmailPort } from "@joelclaw/email";
import { Effect, Option } from "effect";
import type {
  ActionContext,
  SourceAdapter,
  SourceCapabilities,
  SourceItem,
  SourceRef,
} from "../types";
import { SourceError } from "../types";

export type FrontSourceAdapterOptions = {
  /** Explicit semantic gate: true means Done is allowed to archive this conversation. */
  isArchiveResolution: (conversation: EmailConversation) => boolean;
  openUrl?: (conversation: EmailConversation) => string | undefined;
};

function sourceError(
  operation: SourceError["operation"],
  ref: SourceRef,
  message: string,
  cause?: unknown,
): SourceError {
  return new SourceError({ operation, ref, message, cause });
}

export function makeFrontSourceAdapter(
  email: EmailPort,
  options: FrontSourceAdapterOptions,
): SourceAdapter {
  const acknowledgedActionIds = new Set<string>();

  const readConversation = (ref: SourceRef) => {
    if (ref.kind !== "front") {
      return Effect.fail(sourceError("inspect", ref, `Front adapter cannot inspect ${ref.kind}`));
    }
    return Effect.tryPromise({
      try: () => email.getConversation(ref.id),
      catch: (cause) => sourceError("inspect", ref, `Failed to inspect Front conversation ${ref.id}`, cause),
    }).pipe(Effect.map(({ conversation }) => conversation));
  };

  const toSourceItem = (ref: SourceRef, conversation: EmailConversation): SourceItem => {
    const openUrl = options.openUrl?.(conversation);
    return {
      ref: { ...ref, revision: conversation.lastMessageAt.toISOString() },
      title: conversation.subject,
      state: conversation.status === "archived" ? "resolved" : "open",
      semanticAction: options.isArchiveResolution(conversation) ? "archive" : "acknowledge",
      revision: conversation.lastMessageAt.toISOString(),
      ...(openUrl ? { openUrl } : {}),
    };
  };

  const inspect = Effect.fn("FrontSourceAdapter.inspect")(function* (ref: SourceRef) {
    const conversation = yield* readConversation(ref);
    return toSourceItem(ref, conversation);
  });

  const capabilities = (item: SourceItem): SourceCapabilities => {
    const canArchive = item.ref.kind === "front" && item.semanticAction === "archive";
    return {
      resolve: canArchive
        ? { supported: true, idempotency: "read-before-write", button: "Done" }
        : { supported: false, idempotency: "none", button: "Acknowledge" },
      acknowledge: true,
      snooze: { supported: false, mode: "none" },
      openUrl: Boolean(item.openUrl),
    };
  };

  const resolve = Effect.fn("FrontSourceAdapter.resolve")(function* (
    item: SourceItem,
    _context: ActionContext,
  ) {
    const before = yield* inspect(item.ref);
    if (!capabilities(before).resolve.supported) {
      return yield* Effect.fail(
        sourceError(
          "resolve",
          item.ref,
          "Done is unsafe: this item does not semantically mean archive the Front conversation",
        ),
      );
    }
    if (before.state === "resolved") {
      return {
        outcome: "already-applied" as const,
        sourceId: before.ref.id,
        sourceRevision: before.revision,
        openUrl: before.openUrl,
        detail: "Front conversation was already archived",
      };
    }

    yield* Effect.tryPromise({
      try: () => email.archive(before.ref.id),
      catch: (cause) =>
        sourceError("resolve", before.ref, `Failed to archive Front conversation ${before.ref.id}`, cause),
    });

    const after = yield* inspect(before.ref);
    if (after.state !== "resolved") {
      return yield* Effect.fail(
        sourceError("resolve", after.ref, "Front archive returned without archived readback"),
      );
    }

    return {
      outcome: "applied" as const,
      sourceId: after.ref.id,
      sourceRevision: after.revision,
      openUrl: after.openUrl,
      detail: "Front conversation archived and read back",
    };
  });

  const acknowledge = Effect.fn("FrontSourceAdapter.acknowledge")(function* (
    item: SourceItem,
    context: ActionContext,
  ) {
    const alreadyApplied = acknowledgedActionIds.has(context.actionId);
    acknowledgedActionIds.add(context.actionId);
    return {
      outcome: alreadyApplied ? ("already-applied" as const) : ("applied" as const),
      sourceId: item.ref.id,
      sourceRevision: item.revision,
      openUrl: item.openUrl,
      detail: alreadyApplied
        ? "Front interaction was already acknowledged"
        : "Front interaction acknowledged without changing Front",
    };
  });

  const snooze = Effect.fn("FrontSourceAdapter.snooze")(function* (
    item: SourceItem,
    _until: Date,
    _context: ActionContext,
  ) {
    return yield* Effect.fail(
      sourceError("snooze", item.ref, "Front source snooze is not supported by this adapter"),
    );
  });

  const openUrl = Effect.fn("FrontSourceAdapter.openUrl")(function* (item: SourceItem) {
    return item.openUrl ? Option.some(item.openUrl) : Option.none<string>();
  });

  return { inspect, capabilities, resolve, acknowledge, snooze, openUrl };
}
