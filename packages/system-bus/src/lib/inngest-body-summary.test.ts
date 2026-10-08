import { describe, expect, test } from "bun:test";
import { summarizeInngestRequestBody } from "./inngest-body-summary";

describe("Inngest request body summaries", () => {
  test("does not clone GET requests or small POST bodies", async () => {
    const get = new Request("http://localhost/api/inngest", {
      method: "GET",
      headers: { "Content-Length": "100000" },
    });
    const small = new Request("http://localhost/api/inngest", {
      method: "POST",
      headers: { "Content-Length": "2" },
      body: "{}",
    });
    let cloneCalls = 0;
    for (const request of [get, small]) {
      Object.defineProperty(request, "clone", {
        value: () => {
          cloneCalls += 1;
          throw new Error("clone should be skipped");
        },
      });
    }

    const summarize = (raw: string | null) => (raw ? { size: raw.length } : null);
    await expect(summarizeInngestRequestBody(get, summarize)).resolves.toBeNull();
    await expect(summarizeInngestRequestBody(small, summarize)).resolves.toBeNull();
    expect(cloneCalls).toBe(0);
  });

  test("summarizes only large POST and PUT bodies with a known length", async () => {
    const largeBody = "x".repeat(70_000);
    const request = new Request("http://localhost/api/inngest", {
      method: "POST",
      headers: { "Content-Length": String(Buffer.byteLength(largeBody)) },
      body: largeBody,
    });

    await expect(
      summarizeInngestRequestBody(request, (raw) => (raw ? { size: raw.length } : null)),
    ).resolves.toEqual({ size: largeBody.length });
  });

  test("does not clone an unknown-length request body", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(70_000)));
        controller.close();
      },
    });
    const request = new Request("http://localhost/api/inngest", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    let cloneCalls = 0;
    Object.defineProperty(request, "clone", {
      value: () => {
        cloneCalls += 1;
        throw new Error("clone should be skipped without a length header");
      },
    });

    await expect(
      summarizeInngestRequestBody(request, (raw) => (raw ? { size: raw.length } : null)),
    ).resolves.toBeNull();
    expect(cloneCalls).toBe(0);
  });
});
