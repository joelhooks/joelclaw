import { readFile } from "node:fs/promises";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.SUPERMEMORY_FORWARDER_TEST_DATABASE_URL;
const isDisposable = (() => {
  if (databaseUrl === undefined) return false;
  try {
    return /(?:test|tmp|forwarder)/iu.test(new URL(databaseUrl).pathname);
  } catch {
    return false;
  }
})();
const suite = isDisposable ? describe : describe.skip;
const installSql = await readFile(
  new URL("../deploy/install-commit-notifications.sql", import.meta.url),
  "utf8",
);
const rollbackSql = await readFile(
  new URL("../deploy/rollback-commit-notifications.sql", import.meta.url),
  "utf8",
);

suite("PostgreSQL commit notifications", () => {
  const admin = new Client({ connectionString: databaseUrl });
  const listener = new Client({ connectionString: databaseUrl });
  const notifications: Array<{
    readonly channel: string;
    readonly payload: string | undefined;
    readonly processId: number;
  }> = [];

  beforeAll(async () => {
    await admin.connect();
    await listener.connect();
    listener.on("notification", (message) =>
      notifications.push({
        channel: message.channel,
        payload: message.payload,
        processId: message.processId,
      }),
    );
    await admin.query(rollbackSql).catch(() => undefined);
    await admin.query("DROP TABLE IF EXISTS fm_projection_commits, fm_scope_heads CASCADE");
    await admin.query("CREATE TABLE fm_projection_commits (commit_id text PRIMARY KEY)");
    await admin.query("CREATE TABLE fm_scope_heads (scope_id text PRIMARY KEY, head jsonb)");
    await admin.query(installSql);
    await admin.query(installSql);
    await listener.query("LISTEN flowing_memory_committed");
  });

  afterAll(async () => {
    await admin.query(rollbackSql).catch(() => undefined);
    await admin.query("DROP TABLE IF EXISTS fm_projection_commits, fm_scope_heads CASCADE");
    await listener.end();
    await admin.end();
  });

  const waitForCount = async (count: number) => {
    const deadline = Date.now() + 2_000;
    while (notifications.length < count && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  it("emits payload-free wakes after commit but not rollback", async () => {
    await admin.query("BEGIN");
    await admin.query("INSERT INTO fm_projection_commits (commit_id) VALUES ('committed')");
    expect(notifications).toHaveLength(0);
    await admin.query("COMMIT");
    await waitForCount(1);
    expect(notifications).toEqual([
      { channel: "flowing_memory_committed", payload: "", processId: expect.any(Number) },
    ]);

    await admin.query("BEGIN");
    await admin.query("INSERT INTO fm_projection_commits (commit_id) VALUES ('rolled-back')");
    await admin.query("ROLLBACK");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(notifications).toHaveLength(1);
  });

  it("wakes for current scope-head changes without putting memory content in the payload", async () => {
    await admin.query(
      "INSERT INTO fm_scope_heads (scope_id, head) VALUES ('scope', '{\"recordIds\":[\"private-memory\"]}')",
    );
    await waitForCount(2);
    expect(notifications[1]).toMatchObject({
      channel: "flowing_memory_committed",
      payload: "",
    });
    expect(JSON.stringify(notifications)).not.toContain("private-memory");
  });
});
