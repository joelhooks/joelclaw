import { describe, expect, it } from "bun:test";
import { createActor } from "xstate";
import {
  type EscalationRequest,
  type InvestigationBudgets,
  meetsImmediateEscalationGate,
  type OutboundCandidate,
  signalLifecycleMachine,
  telegramOutboundPolicy,
} from "../src";

const budgets: InvestigationBudgets = {
  timeMs: 60_000,
  retries: 2,
  spendUsd: 1,
  mutationAuthority: "safe-recovery",
  scope: ["voice.read", "voice.restart"],
};

function candidate(overrides: Partial<OutboundCandidate> = {}): OutboundCandidate {
  return {
    content: "A source item needs Joel's approval",
    producer: "deploy-gate",
    level: "info",
    priority: "normal",
    sourceEventType: "deploy.approval.required",
    auditLineage: {
      signalId: "signal-1",
      flowId: "flow-1",
    },
    ...overrides,
  };
}

function actorFor(
  overrides: Partial<OutboundCandidate> = {},
  budgetOverrides: Partial<InvestigationBudgets> = {},
) {
  return createActor(signalLifecycleMachine, {
    input: {
      candidate: candidate(overrides),
      budgets: { ...budgets, ...budgetOverrides },
    },
  }).start();
}

function classifyAndRoute(actor: ReturnType<typeof actorFor>) {
  actor.send({ type: "CLASSIFY" });
  expect(actor.getSnapshot().value).toBe("classified");
  actor.send({ type: "ROUTE" });
}

const qualifiedEscalation: EscalationRequest = {
  waitingRisk: "blocked-launch-or-system",
  evidence: "verified-impact",
  detail: "Production enrollment is returning 500s and the readback confirms it.",
};

describe("TelegramOutboundPolicy", () => {
  it.each([
    {
      name: "Joel-owned action",
      input: candidate(),
      expected: ["deliver", "action", "deliver.joel-owned-action"],
    },
    {
      name: "quality reminder",
      input: candidate({
        sourceEventType: "signal.reminder.scheduled",
        content: "Reminder: review the launch proof before 9am",
      }),
      expected: ["deliver", "reminder", "deliver.quality-reminder"],
    },
    {
      name: "memory",
      input: candidate({
        sourceEventType: "memory.reflection.created",
        content: "A relevant memory with source and current connection",
      }),
      expected: ["digest", "memory", "digest.memory-candidate"],
    },
    {
      name: "routine machine noise",
      input: candidate({
        sourceEventType: "system.heartbeat",
        content: "heartbeat ok",
      }),
      expected: ["suppress", "noise", "suppress.routine-machine-noise"],
    },
    {
      name: "raw infrastructure failure",
      input: candidate({
        sourceEventType: "notify.message",
        content: "verify-voice FAILED: recall probe returned 503",
        producer: "cli/notify",
        level: "fatal",
        priority: "urgent",
      }),
      expected: [
        "investigate",
        "infra",
        "investigate.infrastructure-or-escalation-signal",
      ],
    },
    {
      name: "explicit escalation candidate",
      input: candidate({
        sourceEventType: "talon.sos.escalated",
        content: "Talon could not recover the system",
      }),
      expected: [
        "investigate",
        "escalation",
        "investigate.infrastructure-or-escalation-signal",
      ],
    },
    {
      name: "failed recovery attempt",
      input: candidate({
        sourceEventType: "worker.recovery.failed",
        content: "Safe recovery failed and the worker is still unhealthy",
      }),
      expected: [
        "investigate",
        "infra",
        "investigate.infrastructure-or-escalation-signal",
      ],
    },
    {
      name: "verified user-impacting recovery",
      input: candidate({
        sourceEventType: "checkout.recovered",
        content: "Verified healthy by checkout readback",
        priority: "high",
      }),
      expected: [
        "deliver",
        "recovery-receipt",
        "deliver.verified-user-impacting-recovery",
      ],
    },
    {
      name: "routine verified recovery",
      input: candidate({
        sourceEventType: "worker.recovered",
        content: "Verified healthy by worker readback",
      }),
      expected: [
        "digest",
        "recovery-receipt",
        "digest.verified-routine-recovery",
      ],
    },
  ])("classifies $name", ({ input, expected }) => {
    const result = telegramOutboundPolicy(input);
    expect([result.disposition, result.category, result.reason]).toEqual([...expected]);
    expect(result.producer).toBe(input.producer);
  });

  it("fails closed when required classification input is missing", () => {
    const result = telegramOutboundPolicy(
      candidate({
        content: "",
        producer: "",
        sourceEventType: "",
        auditLineage: { signalId: "" },
      }),
    );

    expect(result.disposition).toBe("investigate");
    expect(result.reason).toContain("investigate.unclassifiable");
    expect(result.producer).toBe("unknown");
  });

  it("fails closed when no policy rule matches", () => {
    const result = telegramOutboundPolicy(
      candidate({
        content: "Some opaque output",
        sourceEventType: "custom.unknown",
      }),
    );

    expect(result).toMatchObject({
      disposition: "investigate",
      category: "noise",
      reason: "investigate.unclassifiable.no-policy-match",
    });
  });
});

describe("escalation gate", () => {
  it("requires both waiting risk and concrete evidence", () => {
    expect(meetsImmediateEscalationGate(qualifiedEscalation)).toBe(true);
    expect(
      meetsImmediateEscalationGate({
        ...qualifiedEscalation,
        detail: "   ",
      }),
    ).toBe(false);
  });

  it.each([
    "customer-harm",
    "money-loss",
    "security-or-data-loss",
    "blocked-launch-or-system",
    "explicit-joel-commitment",
  ] as const)("accepts settled waiting risk: %s", (waitingRisk) => {
    expect(
      meetsImmediateEscalationGate({
        waitingRisk,
        evidence: "failed-safe-recovery",
        detail: "Safe recovery failed with a concrete receipt.",
      }),
    ).toBe(true);
  });

  it.each([
    "verified-impact",
    "failed-safe-recovery",
    "joel-decision-or-access-needed",
  ] as const)("accepts settled escalation evidence: %s", (evidence) => {
    expect(
      meetsImmediateEscalationGate({
        waitingRisk: "customer-harm",
        evidence,
        detail: "The impact or remaining Joel-owned dependency is concrete.",
      }),
    ).toBe(true);
  });
});

describe("signal lifecycle actor", () => {
  it("routes the verify-voice FAILED fixture to investigating, never delivered", () => {
    const actor = actorFor({
      sourceEventType: "notify.message",
      content: "verify-voice FAILED: recall probe returned 503",
      producer: "cli/notify",
      level: "fatal",
      priority: "urgent",
    });

    classifyAndRoute(actor);

    expect(actor.getSnapshot().value).toBe("investigating");
    expect(actor.getSnapshot().matches("delivered")).toBe(false);
    actor.stop();
  });

  it("routes policy decisions through classified to every disposition state", () => {
    const cases: Array<
      [
        Partial<OutboundCandidate>,
        "delivered" | "digestQueued" | "suppressed" | "investigating",
      ]
    > = [
      [{}, "delivered"],
      [{ sourceEventType: "memory.created", content: "Useful sourced memory" }, "digestQueued"],
      [{ sourceEventType: "system.heartbeat", content: "ok" }, "suppressed"],
      [
        {
          sourceEventType: "notify.message",
          content: "worker failed",
          level: "error",
        },
        "investigating",
      ],
    ];

    for (const [overrides, expected] of cases) {
      const actor = actorFor(overrides);
      classifyAndRoute(actor);
      expect(actor.getSnapshot().value).toBe(expected);
      actor.stop();
    }
  });

  it("resolves an investigation into the digest", () => {
    const actor = actorFor({ sourceEventType: "worker.failed", content: "worker failed" });
    classifyAndRoute(actor);
    actor.send({ type: "RESOLVE" });
    expect(actor.getSnapshot().value).toBe("resolved");
    actor.send({ type: "QUEUE_DIGEST" });
    expect(actor.getSnapshot().value).toBe("digestQueued");
  });

  it("resolves an investigation through recovery receipt to delivery", () => {
    const actor = actorFor({ sourceEventType: "worker.failed", content: "worker failed" });
    classifyAndRoute(actor);
    actor.send({ type: "RESOLVE" });
    actor.send({ type: "EMIT_RECOVERY_RECEIPT" });
    expect(actor.getSnapshot().value).toBe("recoveryReceipt");
    actor.send({ type: "DELIVER" });
    expect(actor.getSnapshot().value).toBe("delivered");
    actor.send({ type: "DONE" });
    expect(actor.getSnapshot().value).toBe("done");
  });

  it("routes a blocked investigation to digest without escalation", () => {
    const actor = actorFor({ sourceEventType: "worker.failed", content: "worker failed" });
    classifyAndRoute(actor);
    actor.send({ type: "BLOCK" });
    expect(actor.getSnapshot().value).toBe("blocked");
    actor.send({ type: "QUEUE_DIGEST" });
    expect(actor.getSnapshot().value).toBe("digestQueued");
  });

  it("reaches escalated only when the explicit gate passes", () => {
    const actor = actorFor({ sourceEventType: "worker.failed", content: "worker failed" });
    classifyAndRoute(actor);
    actor.send({ type: "VERIFY_IMPACT", request: qualifiedEscalation });
    expect(actor.getSnapshot().value).toBe("verifiedImpact");

    actor.send({
      type: "ESCALATE",
      request: { ...qualifiedEscalation, detail: "" },
    });
    expect(actor.getSnapshot().value).toBe("investigating");
    expect(actor.getSnapshot().context.escalationDeniedCount).toBe(1);

    actor.send({ type: "VERIFY_IMPACT", request: qualifiedEscalation });
    actor.send({ type: "ESCALATE", request: qualifiedEscalation });
    expect(actor.getSnapshot().value).toBe("escalated");
    expect(actor.getSnapshot().context.escalationRequest).toEqual(qualifiedEscalation);

    actor.send({ type: "DELIVER" });
    expect(actor.getSnapshot().value).toBe("delivered");
    actor.stop();
  });

  it("lets a qualified blocked signal pass the same escalation gate", () => {
    const actor = actorFor({ sourceEventType: "worker.failed", content: "worker failed" });
    classifyAndRoute(actor);
    actor.send({ type: "BLOCK", request: qualifiedEscalation });
    actor.send({ type: "ESCALATE", request: qualifiedEscalation });

    expect(actor.getSnapshot().value).toBe("escalated");
    actor.stop();
  });

  it("keeps a blocked signal blocked when escalation does not pass the gate", () => {
    const actor = actorFor({ sourceEventType: "worker.failed", content: "worker failed" });
    classifyAndRoute(actor);
    actor.send({ type: "BLOCK", request: qualifiedEscalation });
    actor.send({
      type: "ESCALATE",
      request: { ...qualifiedEscalation, detail: "" },
    });

    expect(actor.getSnapshot().value).toBe("blocked");
    expect(actor.getSnapshot().context.escalationDeniedCount).toBe(1);
    actor.stop();
  });

  it("collapses duplicate detections only under the stable signal identity", () => {
    const actor = actorFor({ sourceEventType: "worker.failed", content: "worker failed" });
    actor.send({ type: "DUPLICATE_DETECTED", signalId: "different-signal" });
    actor.send({ type: "DUPLICATE_DETECTED", signalId: "signal-1" });
    actor.send({ type: "DUPLICATE_DETECTED", signalId: "signal-1" });

    expect(actor.getSnapshot().value).toBe("detected");
    expect(actor.getSnapshot().context.duplicateCount).toBe(2);
    actor.stop();
  });

  it("models cancellation as a terminal event", () => {
    const actor = actorFor({ sourceEventType: "worker.failed", content: "worker failed" });
    classifyAndRoute(actor);
    actor.send({ type: "CANCEL", reason: "superseded by a newer signal" });

    expect(actor.getSnapshot().value).toBe("cancelled");
    expect(actor.getSnapshot().context.cancellationReason).toBe(
      "superseded by a newer signal",
    );
  });

  it("blocks when retry budget is exhausted", () => {
    const actor = actorFor(
      { sourceEventType: "worker.failed", content: "worker failed" },
      { retries: 1 },
    );
    classifyAndRoute(actor);
    actor.send({ type: "RETRY" });
    expect(actor.getSnapshot().context.usage.retriesUsed).toBe(1);
    actor.send({ type: "RETRY" });

    expect(actor.getSnapshot().value).toBe("blocked");
    expect(actor.getSnapshot().context.blockReason).toBe("retry-budget-exhausted");
  });

  it("blocks when time budget is exhausted", () => {
    const actor = actorFor(
      { sourceEventType: "worker.failed", content: "worker failed" },
      { timeMs: 10 },
    );
    classifyAndRoute(actor);
    actor.send({ type: "ELAPSE", elapsedMs: 10 });
    actor.send({ type: "ELAPSE", elapsedMs: 1 });

    expect(actor.getSnapshot().value).toBe("blocked");
    expect(actor.getSnapshot().context.blockReason).toBe("time-budget-exhausted");
  });

  it("blocks when spend budget is exhausted", () => {
    const actor = actorFor(
      { sourceEventType: "worker.failed", content: "worker failed" },
      { spendUsd: 0.25 },
    );
    classifyAndRoute(actor);
    actor.send({ type: "SPEND", amountUsd: 0.25 });
    actor.send({ type: "SPEND", amountUsd: 0.01 });

    expect(actor.getSnapshot().value).toBe("blocked");
    expect(actor.getSnapshot().context.blockReason).toBe("spend-budget-exhausted");
  });

  it("enforces mutation authority and scope budgets", () => {
    const allowed = actorFor({ sourceEventType: "worker.failed", content: "worker failed" });
    classifyAndRoute(allowed);
    allowed.send({
      type: "REQUEST_MUTATION",
      authority: "safe-recovery",
      scope: "voice.restart",
    });
    expect(allowed.getSnapshot().value).toBe("investigating");
    allowed.stop();

    const authorityDenied = actorFor(
      { sourceEventType: "worker.failed", content: "worker failed" },
      { mutationAuthority: "read" },
    );
    classifyAndRoute(authorityDenied);
    authorityDenied.send({
      type: "REQUEST_MUTATION",
      authority: "safe-recovery",
      scope: "voice.restart",
    });
    expect(authorityDenied.getSnapshot().value).toBe("blocked");
    expect(authorityDenied.getSnapshot().context.blockReason).toBe(
      "mutation-authority-denied",
    );

    const scopeDenied = actorFor({ sourceEventType: "worker.failed", content: "worker failed" });
    classifyAndRoute(scopeDenied);
    scopeDenied.send({
      type: "REQUEST_MUTATION",
      authority: "read",
      scope: "billing.write",
    });
    expect(scopeDenied.getSnapshot().value).toBe("blocked");
    expect(scopeDenied.getSnapshot().context.blockReason).toBe("scope-denied");
  });

  it("supports delivered acknowledgements", () => {
    const actor = actorFor();
    classifyAndRoute(actor);
    actor.send({ type: "ACKNOWLEDGE" });
    expect(actor.getSnapshot().value).toBe("acknowledged");
  });

  it("supports delivered completion", () => {
    const actor = actorFor();
    classifyAndRoute(actor);
    actor.send({ type: "DONE" });
    expect(actor.getSnapshot().value).toBe("done");
  });

  it("redetects a snoozed signal when its timer fires", async () => {
    const actor = actorFor();
    classifyAndRoute(actor);
    actor.send({ type: "SNOOZE", delayMs: 5 });
    expect(actor.getSnapshot().value).toBe("snoozed");

    await Bun.sleep(15);

    expect(actor.getSnapshot().value).toBe("detected");
    expect(actor.getSnapshot().context.decision).toBeUndefined();
    actor.stop();
  });
});
