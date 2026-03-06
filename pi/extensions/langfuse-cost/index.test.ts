import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeModelAttribution, parseUsage } from "./index";

describe("langfuse-cost optional dependency loading", () => {
  test("module import does not crash when langfuse is unavailable", () => {
    const moduleUrl = pathToFileURL(join(import.meta.dir, "index.ts")).href;
    const script = `
      import(${JSON.stringify(moduleUrl)})
        .then(() => process.exit(0))
        .catch((error) => {
          console.error(error?.stack || error?.message || String(error));
          process.exit(1);
        });
    `;

    const run = Bun.spawnSync({
      cmd: [process.execPath, "--eval", script],
      cwd: process.cwd(),
      env: {
        ...process.env,
        LANGFUSE_PUBLIC_KEY: "",
        LANGFUSE_SECRET_KEY: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const stderr = new TextDecoder().decode(run.stderr);

    expect(run.exitCode).toBe(0);
    expect(stderr).not.toContain("Cannot find package 'langfuse'");
    expect(stderr).not.toContain("Cannot find module 'langfuse'");
  });
});

describe("normalizeModelAttribution", () => {
  test("normalizes provider-prefixed and aliased model ids consistently", () => {
    expect(
      normalizeModelAttribution({ provider: "anthropic", id: "anthropic/claude-opus-4-6" }),
    ).toEqual({
      provider: "anthropic",
      modelId: "anthropic/claude-opus-4-6",
    });

    expect(
      normalizeModelAttribution({ provider: "openai", id: "openai-codex/gpt-5.4" }),
    ).toEqual({
      provider: "openai-codex",
      modelId: "openai-codex/gpt-5.4",
    });

    expect(
      normalizeModelAttribution({ provider: "openai-codex", id: "gpt-5.4" }),
    ).toEqual({
      provider: "openai-codex",
      modelId: "openai-codex/gpt-5.4",
    });
  });
});

describe("parseUsage", () => {
  test("parses token and optional cost payloads", () => {
    expect(
      parseUsage({
        input: 100,
        output: 50,
        totalTokens: 180,
        cacheRead: 20,
        cacheWrite: 10,
        cost: {
          input: 0.001,
          output: 0.002,
          cacheRead: 0.0001,
          cacheWrite: 0.0002,
          total: 0.0033,
        },
      }),
    ).toEqual({
      input: 100,
      output: 50,
      totalTokens: 180,
      cacheRead: 20,
      cacheWrite: 10,
      cost: {
        input: 0.001,
        output: 0.002,
        cacheRead: 0.0001,
        cacheWrite: 0.0002,
        total: 0.0033,
      },
    });
  });

  test("remains backward compatible when cost fields are absent", () => {
    expect(
      parseUsage({
        input: 12,
        output: 3,
        totalTokens: 15,
      }),
    ).toEqual({
      input: 12,
      output: 3,
      totalTokens: 15,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });
});
