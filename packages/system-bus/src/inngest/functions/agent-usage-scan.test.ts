import { describe, expect, test } from "bun:test";
import { agentUsageScan } from "./agent-usage-scan";

describe("agent-usage scan scheduling", () => {
  test("serializes scans and does not retry a wedged cron run", () => {
    const options = (agentUsageScan as any).opts;

    expect(options?.concurrency).toMatchObject({ limit: 1 });
    expect(options?.retries).toBe(0);
  });
});
