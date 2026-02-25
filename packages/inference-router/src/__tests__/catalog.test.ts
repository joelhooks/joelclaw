import { describe, expect, test } from "bun:test";
import { GATEWAY_MODEL_TO_PROVIDER, MODEL_CATALOG, inferProviderFromModel, isKnownModel, normalizeModel } from "../catalog";

describe("catalog helpers", () => {
  test("normalizeModel resolves known models and aliases", () => {
    expect(normalizeModel("anthropic/claude-opus-4-6")).toBe("anthropic/claude-opus-4-6");
    expect(normalizeModel("claude-opus-4-6")).toBe("anthropic/claude-opus-4-6");
    expect(normalizeModel("  CLAUDE-HAIKU-4-5 ")).toBe("anthropic/claude-haiku-4-5");
    expect(normalizeModel("OPENAI-CODEX/GPT-5.3-CODEX")).toBe("openai-codex/gpt-5.3-codex");
  });

  test("normalizeModel resolves legacy gateway names", () => {
    for (const legacyName of Object.keys(GATEWAY_MODEL_TO_PROVIDER)) {
      expect(normalizeModel(legacyName)).toBeTruthy();
    }
  });

  test("normalizeModel returns undefined for unknown models", () => {
    expect(normalizeModel("totally-not-a-model")).toBeUndefined();
    expect(normalizeModel("")).toBeUndefined();
    expect(normalizeModel("   ")).toBeUndefined();
  });

  test("inferProviderFromModel resolves all providers and fallback behavior", () => {
    expect(inferProviderFromModel("anthropic/claude-opus-4-6")).toBe("anthropic");
    expect(inferProviderFromModel("openai/gpt-5.2")).toBe("openai");
    expect(inferProviderFromModel("openai-codex/gpt-5.3-codex-spark")).toBe("openai-codex");
    expect(inferProviderFromModel("claude-opus-4-6")).toBe("anthropic");
    expect(inferProviderFromModel("codex-spark")).toBe("openai-codex");
    expect(inferProviderFromModel("openai-ish")).toBe("openai");
    expect(inferProviderFromModel("random-model-name")).toBe("anthropic");
  });

  test("isKnownModel handles positive and negative inputs", () => {
    expect(isKnownModel("anthropic/claude-opus-4-6")).toBe(true);
    expect(isKnownModel("claude-haiku-4-5")).toBe(true);
    expect(isKnownModel("totally-not-a-model")).toBe(false);
    expect(isKnownModel("")).toBe(false);
  });

  test("MODEL_CATALOG entries are complete", () => {
    const allowedTasks = new Set([
      "simple",
      "classification",
      "summary",
      "digest",
      "complex",
      "vision",
      "reasoning",
      "rewrite",
      "json",
      "default",
    ]);

    for (const key of Object.keys(MODEL_CATALOG)) {
      const entry = MODEL_CATALOG[key as keyof typeof MODEL_CATALOG];
      if (!entry) continue;
      expect(entry).toMatchObject({ id: key });
      expect(typeof entry.provider).toBe("string");
      const aliases = Array.isArray(entry.aliases) ? entry.aliases : [];
      const supportedTasks = Array.isArray(entry.supportedTasks) ? entry.supportedTasks : [];
      expect(aliases.length).toBeGreaterThan(0);
      expect(supportedTasks.length).toBeGreaterThan(0);
      for (const task of supportedTasks) {
        expect(allowedTasks.has(task)).toBe(true);
      }
    }
  });
});
