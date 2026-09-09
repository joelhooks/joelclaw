import { createActor, setup } from "xstate";

import type { SupermemoryPort } from "./executor-client.js";
import type { Delivery, DeliveryStatus, ForwarderStateStore } from "./state-store.js";

export type DeliveryOutcome = "accepted" | "deferred" | "delivered" | "indeterminate" | "withheld";

type DeliveryEvent =
  | { readonly type: "FOUND" }
  | { readonly type: "ABSENT" }
  | { readonly type: "RECONCILE_FAILED" }
  | { readonly type: "SEND_ACCEPTED" }
  | { readonly type: "SEND_NOT_CLAIMED" }
  | { readonly type: "SEND_UNCERTAIN" };

export const deliveryMachine = setup({
  types: {
    context: {} as { readonly initialStatus: DeliveryStatus },
    events: {} as DeliveryEvent,
    input: {} as { readonly initialStatus: DeliveryStatus },
  },
  guards: {
    wasAccepted: ({ context }) => context.initialStatus === "accepted",
    wasPending: ({ context }) => context.initialStatus === "pending",
  },
}).createMachine({
  id: "supermemoryDelivery",
  context: ({ input }) => ({ initialStatus: input.initialStatus }),
  initial: "reconciling",
  states: {
    reconciling: {
      on: {
        FOUND: "delivered",
        ABSENT: [
          { guard: "wasPending", target: "sending" },
          { guard: "wasAccepted", target: "accepted" },
          { target: "indeterminate" },
        ],
        RECONCILE_FAILED: [
          { guard: "wasPending", target: "deferred" },
          { guard: "wasAccepted", target: "accepted" },
          { target: "indeterminate" },
        ],
      },
    },
    sending: {
      on: {
        SEND_ACCEPTED: "accepted",
        SEND_NOT_CLAIMED: "deferred",
        SEND_UNCERTAIN: "indeterminate",
      },
    },
    accepted: { type: "final" },
    deferred: { type: "final" },
    delivered: { type: "final" },
    indeterminate: { type: "final" },
  },
});

export const runDelivery = async (input: {
  readonly delivery: Delivery;
  readonly maxReconcileAttempts: number;
  readonly remote: SupermemoryPort;
  readonly store: ForwarderStateStore;
}): Promise<DeliveryOutcome> => {
  const actor = createActor(deliveryMachine, {
    input: { initialStatus: input.delivery.status },
  });
  actor.start();

  let reconciliationCount: number;
  try {
    const found = await input.remote.find(input.delivery.marker);
    reconciliationCount = input.store.recordReconciliation(input.delivery.deliveryId, null);
    if (found !== null) {
      input.store.markDelivered(input.delivery.deliveryId, found.memoryId);
      actor.send({ type: "FOUND" });
      actor.stop();
      return "delivered";
    }
    actor.send({ type: "ABSENT" });
  } catch {
    reconciliationCount = input.store.recordReconciliation(
      input.delivery.deliveryId,
      "reconcile-failed",
    );
    actor.send({ type: "RECONCILE_FAILED" });
    actor.stop();
    if (reconciliationCount >= input.maxReconcileAttempts) {
      if (input.delivery.status === "pending") {
        input.store.markWithheld(input.delivery.deliveryId, "reconcile-budget-exhausted");
        return "withheld";
      }
      input.store.markIndeterminate(input.delivery.deliveryId, "reconcile-budget-exhausted");
      return "indeterminate";
    }
    if (input.delivery.status === "accepted") return "accepted";
    if (input.delivery.status === "pending") return "deferred";
    input.store.markIndeterminate(input.delivery.deliveryId, "reconcile-failed");
    return "indeterminate";
  }

  if (input.delivery.status === "accepted") {
    actor.stop();
    if (reconciliationCount >= input.maxReconcileAttempts) {
      input.store.markIndeterminate(input.delivery.deliveryId, "accepted-not-searchable");
      return "indeterminate";
    }
    return "accepted";
  }
  if (input.delivery.status !== "pending") {
    actor.stop();
    input.store.markIndeterminate(
      input.delivery.deliveryId,
      reconciliationCount >= input.maxReconcileAttempts
        ? "reconcile-budget-exhausted"
        : "send-not-searchable",
    );
    return "indeterminate";
  }

  if (!input.store.markSending(input.delivery.deliveryId)) {
    actor.send({ type: "SEND_NOT_CLAIMED" });
    actor.stop();
    return "deferred";
  }
  try {
    const receipt = await input.remote.save(input.delivery.payload);
    input.store.markAccepted(input.delivery.deliveryId, receipt.documentId, receipt.status);
    actor.send({ type: "SEND_ACCEPTED" });
    return "accepted";
  } catch {
    input.store.markIndeterminate(input.delivery.deliveryId, "send-indeterminate");
    actor.send({ type: "SEND_UNCERTAIN" });
    return "indeterminate";
  } finally {
    actor.stop();
  }
};
