import type { ChatSdkRuntime } from "./instance";

export type MessagingTransportOwnershipState =
  | "legacy-active"
  | "stopping-legacy"
  | "legacy-stopped"
  | "starting-sdk"
  | "sdk-active"
  | "stopping-sdk"
  | "restarting-legacy"
  | "rolled-back";

export interface MessagingTransportOwnershipReceipt {
  readonly state: MessagingTransportOwnershipState;
  readonly at: string;
}

export interface MessagingTransportHandoverDependencies {
  readonly stopLegacyTelegram: () => Promise<void>;
  readonly stopLegacySlack: () => Promise<void>;
  readonly startLegacyTelegram: () => Promise<void>;
  readonly startLegacySlack: () => Promise<void>;
  readonly prepareSdk?: () => void | Promise<void>;
  readonly startSdk: (proof: {
    readonly legacyTransportsStopped: true;
  }) => Promise<ChatSdkRuntime>;
  readonly stopSdk: () => Promise<void>;
  readonly now?: () => Date;
  readonly onTransition?: (
    receipt: MessagingTransportOwnershipReceipt,
  ) => void | Promise<void>;
}

export interface MessagingTransportOwnership {
  readonly state: "sdk-active";
  readonly runtime: ChatSdkRuntime;
  readonly receipts: ReadonlyArray<MessagingTransportOwnershipReceipt>;
  readonly rollback: () => Promise<ReadonlyArray<MessagingTransportOwnershipReceipt>>;
}

function makeTransitionRecorder(
  dependencies: MessagingTransportHandoverDependencies,
  receipts: MessagingTransportOwnershipReceipt[],
) {
  const now = dependencies.now ?? (() => new Date());
  return async (state: MessagingTransportOwnershipState): Promise<void> => {
    const receipt = { state, at: now().toISOString() } as const;
    receipts.push(receipt);
    await dependencies.onTransition?.(receipt);
  };
}

async function restartLegacy(
  dependencies: MessagingTransportHandoverDependencies,
  transition: (state: MessagingTransportOwnershipState) => Promise<void>,
  transports: { readonly telegram: boolean; readonly slack: boolean } = {
    telegram: true,
    slack: true,
  },
): Promise<void> {
  await transition("restarting-legacy");
  const failures: unknown[] = [];

  if (transports.telegram) {
    try {
      await dependencies.startLegacyTelegram();
    } catch (error) {
      failures.push(error);
    }
  }
  if (transports.slack) {
    try {
      await dependencies.startLegacySlack();
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "Failed to restore one or more legacy messaging transports",
    );
  }
  await transition("rolled-back");
}

/**
 * The only legal Telegram/Slack ownership transfer sequence.
 *
 * Legacy polling/socket ownership is released before the SDK starts. Any
 * partial stop/start failure rolls back to legacy. The returned rollback is
 * the supervised cutover escape hatch: SDK stop first, then legacy restart.
 */
export async function handoverMessagingTransports(
  dependencies: MessagingTransportHandoverDependencies,
): Promise<MessagingTransportOwnership> {
  const receipts: MessagingTransportOwnershipReceipt[] = [];
  const transition = makeTransitionRecorder(dependencies, receipts);
  await transition("legacy-active");
  await transition("stopping-legacy");

  let telegramStopped = false;
  let slackStopped = false;
  try {
    await dependencies.stopLegacyTelegram();
    telegramStopped = true;
    await dependencies.stopLegacySlack();
    slackStopped = true;
    await transition("legacy-stopped");
    await dependencies.prepareSdk?.();
    await transition("starting-sdk");
    const runtime = await dependencies.startSdk({
      legacyTransportsStopped: true,
    });
    await transition("sdk-active");

    let rolledBack = false;
    let rollbackPromise:
      | Promise<ReadonlyArray<MessagingTransportOwnershipReceipt>>
      | undefined;
    return {
      state: "sdk-active",
      runtime,
      receipts,
      rollback: async () => {
        if (rolledBack) return receipts;
        if (rollbackPromise) return rollbackPromise;
        rollbackPromise = (async () => {
          await transition("stopping-sdk");
          await dependencies.stopSdk();
          await restartLegacy(dependencies, transition);
          rolledBack = true;
          return receipts;
        })();
        try {
          return await rollbackPromise;
        } finally {
          if (!rolledBack) rollbackPromise = undefined;
        }
      },
    };
  } catch (error) {
    if (telegramStopped && slackStopped) {
      try {
        await transition("stopping-sdk");
        await dependencies.stopSdk();
      } catch (stopError) {
        // Never create two owners. If SDK shutdown cannot be proved, legacy
        // restart is unsafe and must remain a supervised recovery decision.
        throw new AggregateError(
          [error, stopError],
          "Chat SDK handover failed and SDK shutdown is unproven; legacy was not restarted",
        );
      }
    }
    if (telegramStopped || slackStopped) {
      try {
        await restartLegacy(dependencies, transition, {
          telegram: telegramStopped,
          slack: slackStopped,
        });
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Chat SDK handover failed and legacy rollback also failed",
        );
      }
    }
    throw error;
  }
}
