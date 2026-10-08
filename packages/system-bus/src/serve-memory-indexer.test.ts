import { afterAll, expect, test } from "bun:test";

const originalEnv = {
  WORKER_ROLE: process.env.WORKER_ROLE,
  INNGEST_APP_ID: process.env.INNGEST_APP_ID,
  INNGEST_SERVE_HOST: process.env.INNGEST_SERVE_HOST,
};
process.env.WORKER_ROLE = "memory-indexer";
process.env.INNGEST_APP_ID = "system-bus-memory-indexer";
process.env.INNGEST_SERVE_HOST = "http://127.0.0.1:3112";
const { createMemoryIndexerApp } = await import("./serve-memory-indexer");

afterAll(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("memory-indexer exposes health and only its narrow HTTP surface", async () => {
  const app = createMemoryIndexerApp();
  const health = await app.request("/health");
  const payload = await health.json();

  expect(health.status).toBe(200);
  expect(payload.role).toBe("memory-indexer");
  expect(payload.appId).toBe("system-bus-memory-indexer");
  expect(payload.functions).toContain("memory-run-captured-v3");
  expect((await app.request("/api/runs")).status).toBe(404);
});

test("memory-indexer Inngest endpoint serves its isolated registry", async () => {
  const response = await createMemoryIndexerApp().request("/api/inngest");
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.function_count).toBe(5);
});
