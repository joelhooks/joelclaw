import {
  type ActionOperation,
  type ActionRegistryService,
  type MutationReceipt,
  type SourceAdapter,
  type SourceError,
  type SourceItem,
  type SourceRef,
} from "@joelclaw/source-actions";
import { Effect, Either, Option } from "effect";
import {
  BRAIN_PUBLICATION_ORIGIN,
  DEFAULT_DIGEST_ACTION_TTL_MS,
  DEFAULT_DIGEST_SNOOZE_MS,
  type DigestActionCandidate,
  type DigestActionControl,
  type DigestActionOutcome,
  type DigestAdapterMap,
  type DigestControl,
  DigestError,
  type DigestInput,
  type DigestLinkVerifier,
  type DigestMemoryCandidate,
  type DigestReady,
  type DigestReceiptCandidate,
  type DigestRejection,
  type DigestReminderCandidate,
  type DigestResult,
  type DigestTelegramButton,
  type HandleDigestActionInput,
} from "./types";

export type DigestServiceOptions = {
  actionRegistry: ActionRegistryService;
  adapters: DigestAdapterMap;
  verifyLink: DigestLinkVerifier;
  now?: () => Date;
  actionTtlMs?: number;
  snoozeMs?: number;
};

export interface DigestService {
  assemble(input: DigestInput): Effect.Effect<DigestResult, DigestError>;
  handleAction(input: HandleDigestActionInput): Effect.Effect<DigestActionOutcome, DigestError>;
  refreshControls(
    controls: readonly (readonly DigestControl[])[],
  ): Effect.Effect<DigestTelegramButton[][], DigestError>;
}

type QualifiedAction = {
  candidate: DigestActionCandidate | DigestReminderCandidate;
  controls: DigestControl[];
};

function clean(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

function isBrainUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.origin === BRAIN_PUBLICATION_ORIGIN;
  } catch {
    return false;
  }
}

function memoryRejection(candidate: DigestMemoryCandidate): string | undefined {
  if (candidate.quality !== "high") return "memory is not marked high-quality";
  const missing = [
    ["summary", candidate.summary],
    ["source", candidate.source],
    ["when", candidate.happenedAt],
    ["why-now", candidate.whyNow],
    ["connection", candidate.connection],
  ].filter(([, value]) => !clean(value));
  return missing.length > 0
    ? `memory is missing ${missing.map(([field]) => field).join(", ")}`
    : undefined;
}

function receiptRejection(candidate: DigestReceiptCandidate): string | undefined {
  if (!candidate.important) return "receipt is not important";
  if (!clean(candidate.summary) || !clean(candidate.proof)) {
    return "receipt needs a summary and proof";
  }
  if (
    candidate.kind === "recovery-receipt"
    && (!clean(candidate.whatBroke) || !clean(candidate.whatFixedIt))
  ) {
    return "recovery receipt needs what broke and what fixed it";
  }
  return undefined;
}

function ownedCandidateRejection(
  candidate: DigestActionCandidate | DigestReminderCandidate,
): string | undefined {
  if (candidate.owner !== "joel") return "item is not Joel-owned";
  if (!clean(candidate.title)) return "item has no title";
  if (candidate.kind === "reminder") {
    if (!clean(candidate.sourceEvidence) || !clean(candidate.presentRelevance)) {
      return "reminder needs source evidence and present relevance";
    }
    if (candidate.dueAt && candidate.deadlineSource !== "source") {
      return "reminder deadline is not source-backed";
    }
  }
  return undefined;
}

function renderMemory(candidate: DigestMemoryCandidate): string[] {
  return [
    "🧠 Memory",
    candidate.summary.trim(),
    `Source: ${candidate.source.trim()}`,
    `When: ${candidate.happenedAt.trim()}`,
    `Why now: ${candidate.whyNow.trim()}`,
    `Connection: ${candidate.connection.trim()}`,
  ];
}

function renderReceipt(candidate: DigestReceiptCandidate): string[] {
  if (candidate.kind === "agent-win") {
    return ["🛠 Agent win", candidate.summary.trim(), `Receipt: ${candidate.proof.trim()}`];
  }
  return [
    "🟢 Recovery",
    candidate.summary.trim(),
    `Broke: ${candidate.whatBroke?.trim()}`,
    `Fixed: ${candidate.whatFixedIt?.trim()}`,
    `Proof: ${candidate.proof.trim()}`,
    ...(clean(candidate.remainingRisk)
      ? [`Remaining risk: ${candidate.remainingRisk?.trim()}`]
      : []),
  ];
}

function renderOwnedItem(candidate: DigestActionCandidate | DigestReminderCandidate): string[] {
  if (candidate.kind === "action") {
    return ["✅ Yours", candidate.title.trim()];
  }
  return [
    "⏰ Reminder",
    candidate.title.trim(),
    `Evidence: ${candidate.sourceEvidence.trim()}`,
    `Why now: ${candidate.presentRelevance.trim()}`,
    ...(candidate.dueAt ? [`Source deadline: ${candidate.dueAt}`] : []),
  ];
}

function failureText(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return String(error);
}

function digestFailure(
  operation: DigestError["operation"],
  message: string,
  options: { actionId?: string; sourceRef?: SourceRef; cause?: unknown } = {},
): DigestError {
  return new DigestError({ operation, message, ...options });
}

export function renderDigestButtons(
  controls: readonly (readonly DigestControl[])[],
): DigestTelegramButton[][] {
  return controls
    .map((row) =>
      row.map((control) =>
        control.kind === "url"
          ? { text: control.text, url: control.url }
          : { text: control.text, action: control.actionId },
      ),
    )
    .filter((row) => row.length > 0);
}

export function makeDigestService(options: DigestServiceOptions): DigestService {
  const now = options.now ?? (() => new Date());
  const actionTtlMs = options.actionTtlMs ?? DEFAULT_DIGEST_ACTION_TTL_MS;
  const snoozeMs = options.snoozeMs ?? DEFAULT_DIGEST_SNOOZE_MS;

  const adapterFor = (ref: SourceRef): Effect.Effect<SourceAdapter, DigestError> => {
    const adapter = options.adapters[ref.kind];
    return adapter
      ? Effect.succeed(adapter)
      : Effect.fail(
          digestFailure("assemble", `No source adapter registered for ${ref.kind}`, {
            sourceRef: ref,
          }),
        );
  };

  const verifyUrl = Effect.fn("Digest.verifyUrl")(function* (url: string) {
    if (!isBrainUrl(url)) return true;
    const verified = yield* Effect.either(options.verifyLink(url));
    return Either.isRight(verified) && verified.right;
  });

  const sourceUrl = Effect.fn("Digest.sourceUrl")(function* (
    sourceRef: SourceRef | undefined,
    explicitUrl: string | undefined,
  ) {
    let candidateUrl = clean(explicitUrl);
    if (!candidateUrl && sourceRef) {
      const adapterResult = yield* Effect.either(adapterFor(sourceRef));
      if (Either.isRight(adapterResult)) {
        const itemResult = yield* Effect.either(adapterResult.right.inspect(sourceRef));
        if (Either.isRight(itemResult)) {
          const urlResult = yield* Effect.either(adapterResult.right.openUrl(itemResult.right));
          if (Either.isRight(urlResult)) {
            candidateUrl = Option.getOrUndefined(urlResult.right);
          }
        }
      }
    }
    if (!candidateUrl) return undefined;
    return (yield* verifyUrl(candidateUrl)) ? candidateUrl : undefined;
  });

  const registerControl = Effect.fn("Digest.registerControl")(function* (
    text: string,
    sourceRef: SourceRef,
    operation: Exclude<ActionOperation, "open-url">,
  ) {
    const record = yield* options.actionRegistry.register({
      sourceRef,
      allowedOperations: [operation],
      expiresAt: new Date(now().getTime() + actionTtlMs).toISOString(),
    }).pipe(
      Effect.mapError((cause) =>
        digestFailure("assemble", `Failed to register ${operation} control`, {
          sourceRef,
          cause,
        }),
      ),
    );
    return {
      kind: "action" as const,
      text,
      actionId: record.actionId,
      operation,
      sourceRef,
    } satisfies DigestActionControl;
  });

  const qualifyAction = Effect.fn("Digest.qualifyAction")(function* (
    candidate: DigestActionCandidate | DigestReminderCandidate,
  ) {
    const adapterResult = yield* Effect.either(adapterFor(candidate.sourceRef));
    if (Either.isLeft(adapterResult)) return undefined;
    const adapter = adapterResult.right;
    const itemResult = yield* Effect.either(adapter.inspect(candidate.sourceRef));
    if (Either.isLeft(itemResult) || itemResult.right.state === "resolved") return undefined;

    const item = itemResult.right;
    const capabilities = adapter.capabilities(item);
    const controls: DigestControl[] = [];
    if (candidate.kind === "action") {
      if (capabilities.resolve.supported) {
        controls.push(yield* registerControl("✅ Done", item.ref, "resolve"));
      } else if (capabilities.acknowledge) {
        controls.push(yield* registerControl("👍 Acknowledge", item.ref, "acknowledge"));
      }
    } else {
      if (capabilities.acknowledge) {
        controls.push(yield* registerControl("Dismiss", item.ref, "acknowledge"));
      }
      if (capabilities.snooze.supported) {
        controls.push(yield* registerControl("Snooze 4h", item.ref, "snooze"));
      }
    }

    if (capabilities.openUrl) {
      const urlResult = yield* Effect.either(adapter.openUrl(item));
      if (Either.isRight(urlResult)) {
        const url = Option.getOrUndefined(urlResult.right);
        if (url && (yield* verifyUrl(url))) {
          controls.push({ kind: "url", text: "Open source", url });
        }
      }
    }

    return { candidate, controls };
  });

  const assemble = Effect.fn("Digest.assemble")(function* (input: DigestInput) {
    const rejected: DigestRejection[] = [];
    const memories = input.candidates
      .filter((candidate): candidate is DigestMemoryCandidate => candidate.kind === "memory")
      .sort((left, right) => (right.relevance ?? 0) - (left.relevance ?? 0));

    let selectedMemory: DigestMemoryCandidate | undefined;
    let memoryUrl: string | undefined;
    for (const memory of memories) {
      const rejection = memoryRejection(memory);
      if (rejection) {
        rejected.push({ kind: memory.kind, reason: rejection });
        continue;
      }
      const candidateUrl = yield* sourceUrl(memory.sourceRef, memory.sourceUrl);
      if ((memory.sourceUrl || memory.sourceRef?.kind === "brain") && !candidateUrl) {
        rejected.push({ kind: memory.kind, reason: "memory source URL failed verification" });
        continue;
      }
      selectedMemory = memory;
      memoryUrl = candidateUrl;
      break;
    }

    const receipts: DigestReceiptCandidate[] = [];
    const ownedCandidates: Array<DigestActionCandidate | DigestReminderCandidate> = [];
    for (const candidate of input.candidates) {
      if (candidate.kind === "memory") continue;
      if (candidate.kind === "agent-win" || candidate.kind === "recovery-receipt") {
        const rejection = receiptRejection(candidate);
        if (rejection) rejected.push({ kind: candidate.kind, reason: rejection });
        else receipts.push(candidate);
        continue;
      }
      if (candidate.kind === "action" || candidate.kind === "reminder") {
        const rejection = ownedCandidateRejection(candidate);
        if (rejection) rejected.push({ kind: candidate.kind, reason: rejection });
        else ownedCandidates.push(candidate);
      }
    }

    const qualifiedActions: QualifiedAction[] = [];
    for (const candidate of ownedCandidates) {
      const qualified = yield* qualifyAction(candidate);
      if (qualified) qualifiedActions.push(qualified);
      else rejected.push({ kind: candidate.kind, reason: "source item is unavailable or resolved" });
    }

    const includedCandidateCount =
      (selectedMemory ? 1 : 0) + receipts.length + qualifiedActions.length;
    if (includedCandidateCount === 0) {
      return {
        kind: "empty" as const,
        reason: "no-qualified-content" as const,
        rejected,
      };
    }

    const sections: string[][] = [];
    if (selectedMemory) sections.push(renderMemory(selectedMemory));
    sections.push(...receipts.map(renderReceipt));
    sections.push(...qualifiedActions.map(({ candidate }) => renderOwnedItem(candidate)));

    const controls: DigestControl[][] = [];
    if (memoryUrl) controls.push([{ kind: "url", text: "Open memory source", url: memoryUrl }]);
    controls.push(...qualifiedActions.map(({ controls: row }) => row).filter((row) => row.length > 0));

    const intro = input.trigger === "on-demand"
      ? "Yo — here’s the useful stuff right now."
      : "Morning — here’s the useful stuff."
    const ready: DigestReady = {
      kind: "ready",
      payload: {
        text: [intro, ...sections.flatMap((section) => ["", ...section])].join("\n"),
        format: "plain",
        buttons: renderDigestButtons(controls),
        policy: {
          sourceEventType: "signal/digest.assembled",
          priority: "normal",
        },
      },
      controls,
      ...(selectedMemory ? { selectedMemory } : {}),
      includedCandidateCount,
      rejected,
    };
    return ready;
  });

  const executeOperation = (
    adapter: SourceAdapter,
    operation: Exclude<ActionOperation, "open-url">,
    item: SourceItem,
    context: {
      actionId: string;
      actor: "joel";
      telegramMessageId: number;
      requestedAt: string;
    },
  ): Effect.Effect<MutationReceipt, SourceError> => {
    switch (operation) {
      case "resolve":
        return adapter.resolve(item, context);
      case "acknowledge":
        return adapter.acknowledge(item, context);
      case "snooze":
        return adapter.snooze(item, new Date(now().getTime() + snoozeMs), context);
    }
  };

  const handleAction = Effect.fn("Digest.handleAction")(function* (
    input: HandleDigestActionInput,
  ) {
    let record = yield* options.actionRegistry.get(input.actionId).pipe(
      Effect.mapError((cause) =>
        digestFailure("handle-action", "Action registry lookup failed", {
          actionId: input.actionId,
          cause,
        }),
      ),
    );
    if (record.state === "failed") {
      record = yield* options.actionRegistry.retry(input.actionId).pipe(
        Effect.mapError((cause) =>
          digestFailure("handle-action", "Failed action could not be retried", {
            actionId: input.actionId,
            cause,
          }),
        ),
      );
    }
    if (record.state === "expired") {
      return { status: "expired" as const, record };
    }
    if (record.state === "applied" || record.state === "already-applied") {
      if (!record.receipt) {
        return yield* Effect.fail(
          digestFailure("handle-action", "Terminal action is missing its mutation receipt", {
            actionId: input.actionId,
            sourceRef: record.sourceRef,
          }),
        );
      }
      return {
        status: record.receipt.outcome,
        record,
        receipt: record.receipt,
      };
    }

    const operation = record.allowedOperations[0];
    if (
      record.allowedOperations.length !== 1
      || !operation
      || operation === "open-url"
    ) {
      return yield* Effect.fail(
        digestFailure("handle-action", "Digest action must bind exactly one mutation operation", {
          actionId: input.actionId,
          sourceRef: record.sourceRef,
        }),
      );
    }

    const adapter = yield* adapterFor(record.sourceRef).pipe(
      Effect.mapError((cause) =>
        digestFailure("handle-action", cause.message, {
          actionId: input.actionId,
          sourceRef: record.sourceRef,
          cause,
        }),
      ),
    );
    const claimResult = yield* Effect.either(
      options.actionRegistry.authorize(input.actionId, operation),
    );
    if (Either.isLeft(claimResult)) {
      const current = yield* options.actionRegistry.get(input.actionId).pipe(
        Effect.mapError((cause) =>
          digestFailure("handle-action", "Action claim failed and state readback failed", {
            actionId: input.actionId,
            sourceRef: record.sourceRef,
            cause,
          }),
        ),
      );
      if (current.state === "expired") {
        return { status: "expired" as const, record: current };
      }
      return yield* Effect.fail(
        digestFailure("handle-action", "Action could not be claimed", {
          actionId: input.actionId,
          sourceRef: record.sourceRef,
          cause: claimResult.left,
        }),
      );
    }
    const claim = claimResult.right;
    const itemResult = yield* Effect.either(adapter.inspect(record.sourceRef));
    if (Either.isLeft(itemResult)) {
      const failure = failureText(itemResult.left);
      const failed = yield* options.actionRegistry.markFailed(claim, failure).pipe(
        Effect.mapError((cause) =>
          digestFailure("handle-action", "Action failed and could not record failure", {
            actionId: input.actionId,
            sourceRef: record.sourceRef,
            cause,
          }),
        ),
      );
      return { status: "failed" as const, record: failed, failure };
    }

    const context = {
      actionId: input.actionId,
      actor: "joel" as const,
      telegramMessageId: input.telegramMessageId,
      requestedAt: now().toISOString(),
    };
    const mutationResult = yield* Effect.either(
      executeOperation(adapter, operation, itemResult.right, context),
    );
    if (Either.isLeft(mutationResult)) {
      const failure = failureText(mutationResult.left);
      const failed = yield* options.actionRegistry.markFailed(claim, failure).pipe(
        Effect.mapError((cause) =>
          digestFailure("handle-action", "Action failed and could not record failure", {
            actionId: input.actionId,
            sourceRef: record.sourceRef,
            cause,
          }),
        ),
      );
      return { status: "failed" as const, record: failed, failure };
    }

    const settled = yield* options.actionRegistry.applyReceipt(claim, mutationResult.right).pipe(
      Effect.mapError((cause) =>
        digestFailure("handle-action", "Mutation receipt could not settle the action", {
          actionId: input.actionId,
          sourceRef: record.sourceRef,
          cause,
        }),
      ),
    );
    return {
      status: mutationResult.right.outcome,
      record: settled,
      receipt: mutationResult.right,
    };
  });

  const refreshControls = Effect.fn("Digest.refreshControls")(function* (
    controls: readonly (readonly DigestControl[])[],
  ) {
    const rows: DigestTelegramButton[][] = [];
    for (const row of controls) {
      const rendered: DigestTelegramButton[] = [];
      for (const control of row) {
        if (control.kind === "url") {
          rendered.push({ text: control.text, url: control.url });
          continue;
        }
        const record = yield* options.actionRegistry.get(control.actionId).pipe(
          Effect.mapError((cause) =>
            digestFailure("refresh-controls", "Failed to refresh digest action", {
              actionId: control.actionId,
              sourceRef: control.sourceRef,
              cause,
            }),
          ),
        );
        if (record.receipt) continue;
        if (record.state === "pending") {
          rendered.push({ text: control.text, action: control.actionId });
        } else if (record.state === "failed") {
          rendered.push({ text: `↻ Retry ${control.text}`, action: control.actionId });
        } else if (record.state === "expired") {
          rendered.push({ text: `Expired: ${control.text}`, action: control.actionId });
        } else {
          rendered.push({ text: `Receipt missing: ${control.text}`, action: control.actionId });
        }
      }
      if (rendered.length > 0) rows.push(rendered);
    }
    return rows;
  });

  return { assemble, handleAction, refreshControls };
}

export type DigestFetch = (
  url: string,
  init: { method: "GET"; redirect: "manual" },
) => Promise<{ status: number; body?: { cancel(): Promise<void> } | null }>;

export function makeFetchDigestLinkVerifier(
  fetchImpl: DigestFetch = (url, init) => fetch(url, init),
): DigestLinkVerifier {
  return (url) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetchImpl(url, { method: "GET", redirect: "manual" });
        await response.body?.cancel();
        return response.status === 200;
      },
      catch: (cause) =>
        digestFailure("verify-link", `Failed to verify Brain URL: ${url}`, { cause }),
    });
}
