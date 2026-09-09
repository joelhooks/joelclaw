import { type Assessment, assessRecord, type Boundary, type ForwarderPolicy } from "./domain.js";
import type { SupermemoryPort } from "./executor-client.js";
import { type DeliveryOutcome, runDelivery } from "./machine.js";
import type { FlowingMemorySource } from "./source.js";
import type { ForwarderStateStore } from "./state-store.js";

export interface ForwarderTelemetry {
  emit(input: {
    readonly action: string;
    readonly errorCode?: string;
    readonly metadata: Readonly<Record<string, number | string>>;
    readonly success: boolean;
  }): Promise<void>;
}

export interface PassReceipt {
  readonly commitsSeen: number;
  readonly discovered: number;
  readonly excluded: number;
  readonly outcomes: Readonly<Record<DeliveryOutcome, number>>;
  readonly queuedInactiveCorrections: number;
  readonly queuedSupersessionCorrections: number;
}

const noTelemetry: ForwarderTelemetry = { emit: async () => undefined };
const emptyOutcomes = (): Record<DeliveryOutcome, number> => ({
  accepted: 0,
  deferred: 0,
  delivered: 0,
  indeterminate: 0,
  withheld: 0,
});

export class SupermemoryForwarder {
  constructor(
    private readonly input: {
      readonly policy: ForwarderPolicy;
      readonly remote: SupermemoryPort;
      readonly source: FlowingMemorySource;
      readonly state: ForwarderStateStore;
      readonly telemetry?: ForwarderTelemetry;
    },
  ) {}

  async initializeBoundary(): Promise<Boundary> {
    const existing = this.input.state.boundary();
    if (existing !== null) return existing;
    const baseline = await this.input.source.initialBaseline();
    this.input.state.initializeBaseline(baseline.boundary, baseline.commitIds);
    return baseline.boundary;
  }

  async dryRun(): Promise<PassReceipt> {
    if (this.input.state.boundary() === null) throw new Error("activation boundary is not initialized");
    const batch = await this.input.source.listUnseenCommits(this.input.state.seenCommitIds(), 50);
    const assessments = batch.candidates.map((record) => assessRecord(record, this.input.policy));
    return {
      commitsSeen: batch.commits.length,
      discovered: assessments.length,
      excluded: assessments.filter((item) => item._tag === "Excluded").length,
      outcomes: emptyOutcomes(),
      queuedInactiveCorrections: 0,
      queuedSupersessionCorrections: 0,
    };
  }

  private async deliverReady(outcomes: Record<DeliveryOutcome, number>): Promise<void> {
    const deliveries = this.input.state.pendingDeliveries(this.input.policy.maxReconcileAttempts);
    if (deliveries.length > 0) await this.input.remote.verifySpace();
    const firstSaves = deliveries.filter(
      (delivery) => delivery.status === "pending" && delivery.deliveryId.startsWith("save:"),
    );
    const active = await this.input.source.activeCommittedRecords(
      firstSaves.map((delivery) => delivery.recordId),
    );
    const activeById = new Map(active.map((record) => [record.recordId, record]));

    for (const delivery of deliveries) {
      if (delivery.status === "pending" && delivery.deliveryId.startsWith("save:")) {
        const current = activeById.get(delivery.recordId);
        const assessment = current === undefined ? undefined : assessRecord(current, this.input.policy);
        if (
          assessment === undefined ||
          assessment._tag === "Excluded" ||
          assessment.memory.payloadHash !== delivery.payloadHash
        ) {
          this.input.state.markWithheld(delivery.deliveryId, "authority-or-policy-ineligible");
          outcomes.withheld += 1;
          continue;
        }
      }
      const outcome = await runDelivery({
        delivery,
        maxReconcileAttempts: this.input.policy.maxReconcileAttempts,
        remote: this.input.remote,
        store: this.input.state,
      });
      outcomes[outcome] += 1;
    }
  }

  async runCanary(recordId: string): Promise<DeliveryOutcome> {
    const delivery = this.input.state.delivery(`save:${recordId}`);
    if (delivery === null) throw new Error("canary delivery is not queued");
    if (delivery.status === "pending") {
      const current = (await this.input.source.activeCommittedRecords([recordId]))[0];
      const assessment = current === undefined ? undefined : assessRecord(current, this.input.policy);
      if (
        assessment === undefined ||
        assessment._tag === "Excluded" ||
        assessment.memory.payloadHash !== delivery.payloadHash
      ) {
        this.input.state.markWithheld(delivery.deliveryId, "authority-or-policy-ineligible");
        return "withheld";
      }
    }
    await this.input.remote.verifySpace();
    return runDelivery({
      delivery,
      maxReconcileAttempts: this.input.policy.maxReconcileAttempts,
      remote: this.input.remote,
      store: this.input.state,
    });
  }

  async runPass(): Promise<PassReceipt> {
    const telemetry = this.input.telemetry ?? noTelemetry;
    if (this.input.state.boundary() === null) throw new Error("activation boundary is not initialized");

    try {
      let commitsSeen = 0;
      let discovered = 0;
      let excluded = 0;
      for (let batchNumber = 0; batchNumber < 20; batchNumber += 1) {
        const batch = await this.input.source.listUnseenCommits(
          this.input.state.seenCommitIds(),
          50,
        );
        if (batch.commits.length === 0) break;
        const assessments: readonly Assessment[] = batch.candidates.map((record) =>
          assessRecord(record, this.input.policy),
        );
        this.input.state.ingest(assessments, batch.commits);
        commitsSeen += batch.commits.length;
        discovered += assessments.length;
        excluded += assessments.filter((item) => item._tag === "Excluded").length;
        if (batch.commits.length < 50) break;
      }

      const deliveredIds = this.input.state.deliveredSourceRecordIds();
      const activeRecords = await this.input.source.activeCommittedRecords(deliveredIds);
      const activeIds = new Set(activeRecords.map((record) => record.recordId));
      let queuedInactiveCorrections = 0;
      for (const recordId of deliveredIds) {
        if (!activeIds.has(recordId)) {
          this.input.state.queueCorrection(recordId, "inactive");
          queuedInactiveCorrections += 1;
        }
      }

      const outcomes = emptyOutcomes();
      await this.deliverReady(outcomes);
      const queuedSupersessionCorrections = this.input.state.queueReadySupersessionCorrections();
      if (queuedSupersessionCorrections > 0) await this.deliverReady(outcomes);

      const receipt: PassReceipt = {
        commitsSeen,
        discovered,
        excluded,
        outcomes,
        queuedInactiveCorrections,
        queuedSupersessionCorrections,
      };
      await telemetry
        .emit({
          action: "memory.supermemory_forwarder.pass",
          metadata: {
            commitsSeen,
            discovered,
            excluded,
            accepted: outcomes.accepted,
            delivered: outcomes.delivered,
            deferred: outcomes.deferred,
            indeterminate: outcomes.indeterminate,
            withheld: outcomes.withheld,
          },
          success: outcomes.indeterminate === 0,
          ...(outcomes.indeterminate > 0 ? { errorCode: "indeterminate-delivery" } : {}),
        })
        .catch(() => undefined);
      return receipt;
    } catch (error) {
      await telemetry
        .emit({
          action: "memory.supermemory_forwarder.pass",
          errorCode: "pass-failed",
          metadata: {},
          success: false,
        })
        .catch(() => undefined);
      throw error;
    }
  }
}
