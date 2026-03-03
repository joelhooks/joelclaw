import { describe, expect, test } from "bun:test";
import { buildGatewayTurnKnowledgeWrite } from "./knowledge-turn";

describe("gateway turn knowledge writer", () => {
  test("marks heartbeat turns as routine-heartbeat skips", () => {
    const result = buildGatewayTurnKnowledgeWrite({
      source: "heartbeat",
      sessionId: "sess-1",
      turnNumber: 3,
      assistantText: "HEARTBEAT_OK",
      toolCalls: [],
      toolErrorCount: 0,
    });

    expect(result.payload.skipReason).toBe("routine-heartbeat");
  });

  test("marks empty non-tool turns as no-new-information", () => {
    const result = buildGatewayTurnKnowledgeWrite({
      source: "gateway",
      sessionId: "sess-1",
      turnNumber: 4,
      assistantText: "",
      toolCalls: [],
      toolErrorCount: 0,
    });

    expect(result.payload.skipReason).toBe("no-new-information");
  });

  test("marks repeated signals as duplicate-signal", () => {
    const first = buildGatewayTurnKnowledgeWrite({
      source: "telegram:123",
      sessionId: "sess-1",
      turnNumber: 5,
      assistantText: "Done. Restarted worker and checked status.",
      toolCalls: [],
      toolErrorCount: 0,
    });

    const second = buildGatewayTurnKnowledgeWrite({
      source: "telegram:123",
      sessionId: "sess-1",
      turnNumber: 6,
      assistantText: "Done. Restarted worker and checked status.",
      toolCalls: [],
      toolErrorCount: 0,
      previousFingerprint: first.fingerprint,
    });

    expect(second.payload.skipReason).toBe("duplicate-signal");
  });

  test("captures meaningful tool turns without skip", () => {
    const result = buildGatewayTurnKnowledgeWrite({
      source: "telegram:123",
      sessionId: "sess-2",
      turnNumber: 1,
      assistantText: "I deployed the worker and verified pods are ready.",
      toolCalls: ["kubectl", "joelclaw"],
      toolErrorCount: 0,
    });

    expect(result.payload.skipReason).toBeUndefined();
    expect(result.payload.summary).toContain("deployed the worker");
    expect(result.payload.usefulnessTags).toContain("tool-use");
  });
});
