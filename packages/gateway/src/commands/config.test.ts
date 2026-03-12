import { describe, expect, test } from "bun:test";
import {
  defaultGatewayConfig,
  GATEWAY_CONFIG_KEY,
  loadGatewayConfig,
  saveGatewayConfig,
} from "./config";

describe("gateway config fallback timeout normalization", () => {
  test("floors claude-opus-4-6 fallback timeout to 240s when loading config", async () => {
    const redis = {
      get: async () => JSON.stringify({
        model: "claude-opus-4-6",
        fallbackProvider: "openai-codex",
        fallbackModel: "gpt-5.4",
        fallbackTimeoutMs: 120_000,
        fallbackAfterFailures: 3,
        recoveryProbeIntervalMs: 600_000,
      }),
    };

    const config = await loadGatewayConfig(redis as any);
    expect(config.model).toBe("claude-opus-4-6");
    expect(config.fallbackTimeoutMs).toBe(240_000);
  });

  test("preserves shorter fallback timeout for non-opus primary models", async () => {
    const redis = {
      get: async () => JSON.stringify({
        model: "gpt-5.4",
        fallbackProvider: "openai-codex",
        fallbackModel: "gpt-5.4-mini",
        fallbackTimeoutMs: 120_000,
        fallbackAfterFailures: 3,
        recoveryProbeIntervalMs: 600_000,
      }),
    };

    const config = await loadGatewayConfig(redis as any);
    expect(config.model).toBe("gpt-5.4");
    expect(config.fallbackTimeoutMs).toBe(120_000);
  });

  test("saveGatewayConfig persists the opus timeout floor", async () => {
    let storedKey = "";
    let storedValue = "";
    const redis = {
      set: async (key: string, value: string) => {
        storedKey = key;
        storedValue = value;
      },
    };

    await saveGatewayConfig(redis as any, {
      ...defaultGatewayConfig(),
      model: "claude-opus-4-6",
      fallbackProvider: "openai-codex",
      fallbackModel: "gpt-5.4",
      fallbackTimeoutMs: 120_000,
      fallbackAfterFailures: 3,
      recoveryProbeIntervalMs: 600_000,
    });

    expect(storedKey).toBe(GATEWAY_CONFIG_KEY);
    expect(JSON.parse(storedValue).fallbackTimeoutMs).toBe(240_000);
  });
});
