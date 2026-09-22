import { describe, expect, test } from "vitest";
import { createQuiverClient, QuiverError, type FetchLike } from "./quiver-client.ts";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("quiver client", () => {
  test("generate posts the snake_case body and maps the response", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return json(200, {
        id: "gen_1",
        created: 1,
        credits: 2,
        data: [{ mime_type: "image/svg+xml", svg: "<svg/>" }],
      });
    };
    const client = createQuiverClient({ apiKey: "k", fetchImpl });
    const result = await client.generate({
      prompt: "a rat",
      model: "arrow-1.1",
      n: 1,
      reasoningEffort: "low",
      references: ["https://example.com/a.png"],
    });
    expect(result).toEqual({
      id: "gen_1",
      created: 1,
      credits: 2,
      usage: undefined,
      data: [{ mimeType: "image/svg+xml", svg: "<svg/>" }],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.quiver.ai/v1/svgs/generations");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer k");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      model: "arrow-1.1",
      prompt: "a rat",
      n: 1,
      stream: false,
      reasoning_effort: "low",
      references: [{ url: "https://example.com/a.png" }],
    });
  });

  test("error envelopes become QuiverError", async () => {
    const fetchImpl: FetchLike = async () =>
      json(402, { code: "insufficient_credits", message: "Top up", status: 402, request_id: "req_9", retry_after: 30 });
    const client = createQuiverClient({ apiKey: "k", fetchImpl });
    const error = await client.listModels().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QuiverError);
    expect((error as QuiverError).toJSON()).toEqual({
      code: "insufficient_credits",
      message: "Top up",
      status: 402,
      requestId: "req_9",
      retryAfter: 30,
    });
  });

  test("models map pricing and operations", async () => {
    const fetchImpl: FetchLike = async () =>
      json(200, {
        object: "list",
        data: [
          {
            id: "arrow-1.1",
            name: "Arrow 1.1",
            supported_operations: ["svg_generate"],
            pricing_credits: { svg_generate: 3, svg_vectorize: 2 },
          },
        ],
      });
    const client = createQuiverClient({ apiKey: "k", fetchImpl });
    expect(await client.listModels()).toEqual([
      {
        id: "arrow-1.1",
        name: "Arrow 1.1",
        description: undefined,
        supportedOperations: ["svg_generate"],
        pricingCredits: { svg_generate: 3, svg_vectorize: 2 },
      },
    ]);
  });
});
