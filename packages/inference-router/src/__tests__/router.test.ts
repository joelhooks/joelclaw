import { describe, expect, test } from "bun:test";
import { DEFAULT_TASK_TO_MODELS, MODEL_CATALOG } from "../catalog";
import { buildInferenceRoute, buildPolicy } from "../router";

describe("buildInferenceRoute", () => {
  test("builds route for explicit model", () => {
    const plan = buildInferenceRoute(
      {
        model: "openai-codex/gpt-5.3-codex",
        task: "reasoning",
      },
      buildPolicy(),
    );

    expect(plan.requestedModel).toBe("openai-codex/gpt-5.3-codex");
    expect(plan.normalizedTask).toBe("reasoning");
    expect(plan.attempts[0]).toMatchObject({
      model: "openai-codex/gpt-5.3-codex",
      provider: "openai-codex",
      reason: "requested",
      attempt: 0,
    });
    expect(plan.attempts[0]).toMatchObject({ model: expect.stringMatching(/^openai-codex\//), reason: "requested" });
  });

  test("builds task-only route using policy defaults", () => {
    const plan = buildInferenceRoute({ task: "vision" }, buildPolicy({ maxFallbackAttempts: 10 }));

    expect(plan.normalizedTask).toBe("vision");
    expect(plan.requestedModel).toBeUndefined();
    expect(plan.attempts[0]!.reason).toBe("policy");
    expect(plan.attempts).toEqual([
      { model: "anthropic/claude-sonnet-4-6", provider: "anthropic", reason: "policy", attempt: 0 },
      { model: "anthropic/claude-opus-4-6", provider: "anthropic", reason: "policy", attempt: 1 },
      { model: "anthropic/claude-haiku-4-5", provider: "anthropic", reason: "policy", attempt: 2 },
      { model: "openai-codex/gpt-5.3-codex-spark", provider: "openai-codex", reason: "fallback", attempt: 3 },
    ]);
  });

  test("builds route with provider filter", () => {
    const plan = buildInferenceRoute({ task: "classification", provider: "openai-codex" }, buildPolicy({ maxFallbackAttempts: 10 }));

    expect(plan.attempts[0]!).toMatchObject({
      model: "openai-codex/gpt-5.3-codex-spark",
      provider: "openai-codex",
      reason: "policy",
      attempt: 0,
    });
    expect(plan.attempts).toContainEqual({
      model: "anthropic/claude-haiku-4-5",
      provider: "anthropic",
      reason: "fallback",
      attempt: 1,
    });
    expect(plan.attempts).toContainEqual({
      model: "anthropic/claude-sonnet-4-6",
      provider: "anthropic",
      reason: "fallback",
      attempt: 2,
    });
    expect(plan.attempts).toHaveLength(3);
  });

  test("deduplicates fallback attempts and respects max attempts", () => {
    const plan = buildInferenceRoute(
      { model: "openai-codex/gpt-5.3-codex-spark" },
      buildPolicy({ maxFallbackAttempts: 2 }),
    );

    expect(plan.attempts).toHaveLength(2);
    expect(new Set(plan.attempts.map((entry) => entry.model)).size).toBe(plan.attempts.length);
    expect(plan.attempts[0]!).toMatchObject({ model: "openai-codex/gpt-5.3-codex-spark", reason: "requested" });
    expect(plan.attempts[1]!).toMatchObject({ model: "anthropic/claude-haiku-4-5", reason: "fallback" });
  });

  test("throws in strict mode for unknown model", () => {
    expect(() => buildInferenceRoute({ model: "totally-unknown-model", strict: true })).toThrow(/unknown model/);
  });

  test("throws in strict mode for unknown task", () => {
    expect(() => buildInferenceRoute({ task: "random-task" as any, strict: true })).toThrow(/unknown task/);
  });

  test("falls through gracefully in permissive mode for unknown model", () => {
    const plan = buildInferenceRoute({ model: "totally-unknown-model", task: "summary", strict: false });

    expect(plan.requestedModel).toBeUndefined();
    expect(plan.attempts[0]!).toMatchObject({
      model: DEFAULT_TASK_TO_MODELS.summary[0],
      provider: MODEL_CATALOG[DEFAULT_TASK_TO_MODELS.summary[0]!]!.provider,
      reason: "policy",
      attempt: 0,
    });
  });

  test("buildPolicy merges overrides and clamps maxFallbackAttempts", () => {
    const policy = buildPolicy({
      strict: true,
      allowLegacy: false,
      maxFallbackAttempts: 0,
      defaults: {
        simple: ["openai/gpt-5.2"],
      } as any,
    });

    expect(policy.strict).toBe(true);
    expect(policy.allowLegacy).toBe(false);
    expect(policy.maxFallbackAttempts).toBe(1);
    expect(policy.defaults.simple).toEqual(["openai/gpt-5.2"]);
    expect(policy.defaults.classification).toEqual(DEFAULT_TASK_TO_MODELS.classification);
  });

  test("handles empty input", () => {
    const plan = buildInferenceRoute({}, buildPolicy());

    expect(plan.requestedModel).toBeUndefined();
    expect(plan.normalizedTask).toBe("default");
    expect(plan.attempts.length).toBeGreaterThan(0);
    expect(plan.attempts[0]!.reason).toBe("policy");
    expect(plan.policyVersion).toBe("2026-02-25-router-v2");
  });

  test("handles no candidates available by throwing", () => {
    const policy = buildPolicy({
      defaults: {
        simple: [],
        classification: [],
        summary: [],
        digest: [],
        vision: [],
        reasoning: [],
        json: [],
        default: [],
        rewrite: [],
      } as any,
      maxFallbackAttempts: 1,
    });

    const plan = buildInferenceRoute({ task: "simple", provider: "openai-codex" }, policy);
    expect(plan.attempts).toEqual([
      { model: "anthropic/claude-haiku-4-5", provider: "anthropic", reason: "fallback", attempt: 0 },
    ]);
  });
});
