import { expect, test } from "bun:test";
import { getExpectedFunctions, getTriggerAuditConfig } from "./trigger-audit";

test("memory-indexer trigger audit uses its own app and callback endpoint", () => {
  const config = getTriggerAuditConfig({ WORKER_ROLE: "memory-indexer" });
  expect(config.workerRole).toBe("memory-indexer");
  expect(config.appId).toBe("system-bus-memory-indexer");
  expect(config.baseUrl.toString()).toBe("http://localhost:3112/");
});

test("memory-indexer trigger audit sees only its function registry", async () => {
  const config = getTriggerAuditConfig({ WORKER_ROLE: "memory-indexer" });
  const expected = await getExpectedFunctions(config);
  expect([...expected.keys()].sort()).toEqual([
    "system-bus-memory-indexer-meeting-transcript-index",
    "system-bus-memory-indexer-memory-run-captured-v3",
    "system-bus-memory-indexer-transcript-index-web",
  ]);
});
