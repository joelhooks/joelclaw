import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { __testables, estimateCost, getModelRate, type ModelRate } from "./model-pricing";

const openrouterBody = {
  data: [
    { id: "openai/gpt-5.6-sol", pricing: { prompt: "0.000002", completion: "0.000006" } },
    { id: "anthropic/claude-haiku-4.5", pricing: { prompt: "0.000001", completion: "0.000005" } },
    { id: "anthropic/claude-opus-4-6", pricing: { prompt: "0.000015", completion: "0.000075" } },
  ],
};

function fetchReturning(body: unknown): (url: string) => Promise<Response> {
  return async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

async function failingFetch(): Promise<Response> {
  throw new Error("network down");
}

const tmpDirs: string[] = [];

async function tmpCachePath(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "model-pricing-test-"));
  tmpDirs.push(dir);
  return path.join(dir, "openrouter-pricing.json");
}

afterEach(async () => {
  __testables.resetPricingMemo();
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const benchmarkRate: ModelRate = {
  model: "openai/gpt-5.6-sol",
  promptUsdPerToken: 0.000002,
  completionUsdPerToken: 0.000006,
  source: "openrouter",
  fetchedAt: Date.now(),
};

describe("estimateCost", () => {
  test("prefers provider cost over benchmark rate", () => {
    const estimate = estimateCost(
      { inputTokens: 1000, outputTokens: 10, costTotal: 0.42 },
      benchmarkRate,
    );
    expect(estimate).toEqual({ costTotal: 0.42, source: "provider" });
  });

  test("computes benchmark cost from token counts", () => {
    const estimate = estimateCost({ inputTokens: 1000, outputTokens: 10 }, benchmarkRate);
    expect(estimate?.source).toBe("openrouter-benchmark");
    expect(estimate?.costTotal).toBeCloseTo(1000 * 0.000002 + 10 * 0.000006, 12);
    expect(estimate?.rate).toEqual(benchmarkRate);
  });

  test("returns null without rate or provider cost", () => {
    expect(estimateCost({ inputTokens: 1000, outputTokens: 10 }, null)).toBeNull();
  });

  test("returns null with rate but no token counts", () => {
    expect(estimateCost({}, benchmarkRate)).toBeNull();
  });
});

describe("getModelRate", () => {
  test("matches dash/dot version variants across provider prefixes", async () => {
    const cachePath = await tmpCachePath();
    const rate = await getModelRate("anthropic/claude-haiku-4-5", {
      fetchImpl: fetchReturning(openrouterBody),
      cachePath,
    });
    expect(rate).not.toBeNull();
    expect(rate?.model).toBe("anthropic/claude-haiku-4.5");
    expect(rate?.promptUsdPerToken).toBe(0.000001);
    expect(rate?.completionUsdPerToken).toBe(0.000005);
    expect(rate?.source).toBe("openrouter");
  });

  test("matches bare model id against provider-prefixed openrouter id", async () => {
    const cachePath = await tmpCachePath();
    const rate = await getModelRate("gpt-5.6-sol", {
      fetchImpl: fetchReturning(openrouterBody),
      cachePath,
    });
    expect(rate?.model).toBe("openai/gpt-5.6-sol");
    expect(rate?.promptUsdPerToken).toBe(0.000002);
    expect(rate?.completionUsdPerToken).toBe(0.000006);
  });

  test("returns null for unknown model", async () => {
    const cachePath = await tmpCachePath();
    const rate = await getModelRate("acme/totally-unknown-model", {
      fetchImpl: fetchReturning(openrouterBody),
      cachePath,
    });
    expect(rate).toBeNull();
  });

  test("returns null when fetch fails and no cache exists", async () => {
    const cachePath = await tmpCachePath();
    const rate = await getModelRate("gpt-5.6-sol", {
      fetchImpl: failingFetch,
      cachePath,
    });
    expect(rate).toBeNull();
  });

  test("falls back to stale cache when fetch fails", async () => {
    const cachePath = await tmpCachePath();
    const staleFetchedAt = Date.now() - 48 * 60 * 60 * 1000;
    await writeFile(
      cachePath,
      JSON.stringify({
        fetchedAt: staleFetchedAt,
        models: [
          {
            id: "openai/gpt-5.6-sol",
            promptUsdPerToken: 0.000002,
            completionUsdPerToken: 0.000006,
          },
        ],
      }),
      "utf8",
    );

    const rate = await getModelRate("gpt-5.6-sol", {
      fetchImpl: failingFetch,
      cachePath,
    });
    expect(rate).not.toBeNull();
    expect(rate?.model).toBe("openai/gpt-5.6-sol");
    expect(rate?.fetchedAt).toBe(staleFetchedAt);
  });

  test("writes cache file after a successful fetch", async () => {
    const cachePath = await tmpCachePath();
    await getModelRate("gpt-5.6-sol", {
      fetchImpl: fetchReturning(openrouterBody),
      cachePath,
    });
    const stored = JSON.parse(await readFile(cachePath, "utf8")) as {
      fetchedAt: number;
      models: Array<{ id: string }>;
    };
    expect(stored.models.map((entry) => entry.id)).toContain("anthropic/claude-haiku-4.5");
    expect(stored.fetchedAt).toBeGreaterThan(0);
  });
});
