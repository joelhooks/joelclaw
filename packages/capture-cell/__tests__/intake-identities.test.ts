import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { main } from "../src/intake/cli";
import { createIntakeIdentities, exportIdentities } from "../src/intake/identities";
import { createIntakeHandler } from "../src/intake/server";
import { openIntake, owedPage } from "../src/intake/store";
import { turnLines } from "./fixtures";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const row = (token = "machine-secret", revoked_at: number | null = null) => ({
  token_sha256: hash(token),
  machine_id: "authenticated-machine",
  user_id: "authenticated-user",
  revoked_at,
});
function fixture(initial: unknown = [row()]) {
  const root = mkdtempSync(
    join(process.env.CAPTURE_TEST_ROOT ?? join(homedir(), ".cache"), "intake-identities-"),
  );
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "identities.json");
  if (initial !== null) writeFileSync(path, JSON.stringify(initial));
  const warnings: string[] = [];
  const identities = createIntakeIdentities(path, () => warnings.push("reload failed"));
  const store = openIntake(join(root, "store"));
  cleanups.push(() => store.close());
  const handler = createIntakeHandler({
    store,
    identities,
    ingestToken: "ingest",
    pullToken: "pull",
    principal: { user_id: "shared-user" },
  });
  const body = {
    run_id: "machine-run",
    agent_runtime: "claude-code",
    jsonl: turnLines(1),
    machine_id: "spoofed-machine",
    user_id: "spoofed-user",
  };
  const post = (token: string, data: object = body) =>
    handler(
      new Request("http://intake/api/runs", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify(data),
      }),
    );
  const replace = (value: unknown) => {
    writeFileSync(`${path}.next`, JSON.stringify(value));
    renameSync(`${path}.next`, path);
  };
  return { root, path, identities, store, handler, body, post, replace, warnings };
}

test("hook machine token stamps trusted machine and user instead of payload", async () => {
  const f = fixture();
  expect((await f.post("machine-secret")).status).toBe(202);
  expect(owedPage(f.store)[0]!.metadata).toMatchObject({
    machine_id: "authenticated-machine",
    user_id: "authenticated-user",
  });
});
test("identity supplies a missing payload machine; ingest token keeps payload machine", async () => {
  const f = fixture();
  const { machine_id: _machine, ...body } = f.body;
  expect((await f.post("machine-secret", body)).status).toBe(202);
  expect((await f.post("ingest", { ...f.body, run_id: "shared-run" })).status).toBe(202);
  expect(owedPage(f.store)[1]!.metadata).toMatchObject({
    machine_id: "spoofed-machine",
    user_id: "shared-user",
  });
});
test.each([0, 1234])("revoked identity %s cannot ingest", async (revoked) => {
  const f = fixture([row("machine-secret", revoked)]);
  expect((await f.post("machine-secret")).status).toBe(401);
  expect(owedPage(f.store)).toEqual([]);
});
test("machine identity never authorizes pull, blob, ack or transfer", async () => {
  const f = fixture();
  for (const [method, path] of [
    ["GET", "/owed"],
    ["GET", "/blob/anything"],
    ["POST", "/ack"],
    ["POST", "/transfer"],
    ["POST", "/transfer-back"],
  ]) {
    expect(
      (
        await f.handler(
          new Request(`http://intake${path}`, {
            method,
            headers: { authorization: "Bearer machine-secret" },
          }),
        )
      ).status,
    ).toBe(401);
  }
  expect(
    (
      await f.handler(
        new Request("http://intake/owed", { headers: { authorization: "Bearer pull" } }),
      )
    ).status,
  ).toBe(200);
});
test("mtime/atomic replacement rotates and revokes tokens; explicit empty set clears", async () => {
  const f = fixture();
  f.replace([row("replacement")]);
  expect((await f.post("machine-secret")).status).toBe(401);
  expect((await f.post("replacement")).status).toBe(202);
  f.replace([row("replacement", 1)]);
  expect((await f.post("replacement")).status).toBe(401);
  f.replace([]);
  expect((await f.post("replacement")).status).toBe(401);
  expect((await f.post("ingest", { ...f.body, run_id: "fallback" })).status).toBe(202);
});
test("invalid/missing file keeps last good, logs once, and never disables ingest token", async () => {
  const f = fixture();
  writeFileSync(f.path, '{"token":"must-not-log"');
  expect((await f.post("machine-secret")).status).toBe(202);
  expect((await f.post("machine-secret")).status).toBe(202);
  expect(f.warnings).toHaveLength(1);
  unlinkSync(f.path);
  expect((await f.post("machine-secret")).status).toBe(202);
  expect((await f.post("machine-secret")).status).toBe(202);
  expect(f.warnings).toHaveLength(2);
  expect((await f.post("ingest", { ...f.body, run_id: "fallback" })).status).toBe(202);
  f.replace([row("new-token")]);
  expect((await f.post("machine-secret")).status).toBe(401);
  expect((await f.post("new-token", { ...f.body, run_id: "new-run" })).status).toBe(202);
});
test("cold missing file and throwing warning sink leave ingest auth usable", async () => {
  const f = fixture(null);
  expect((await f.post("machine-secret")).status).toBe(401);
  expect((await f.post("ingest")).status).toBe(202);
  const registry = createIntakeIdentities(f.path, () => {
    throw new Error("sink unavailable");
  });
  expect(() => registry.reload(true)).not.toThrow();
});
test("invalid schema or duplicate hash cannot replace the last good set", async () => {
  const f = fixture();
  for (const bad of [
    [row(), row()],
    [{ ...row(), revoked_at: "no" }],
    [{ ...row(), token_sha256: "short" }],
    [{ ...row(), user_id: "" }],
    [{ ...row(), token: "never-accepted" }],
  ]) {
    f.replace(bad);
    expect((await f.post("machine-secret")).status).toBe(202);
  }
});
test("export reads only existing auth cache hashes/ids, including revocation", async () => {
  const f = fixture();
  const path = join(f.root, "central.db");
  const db = new Database(path);
  db.exec(
    "CREATE TABLE capture_identities(token_sha256 TEXT,machine_id TEXT,user_id TEXT,revoked_at INTEGER,did TEXT,synced_at INTEGER)",
  );
  db.query("INSERT INTO capture_identities VALUES (?,?,?,?,?,?)").run(
    hash("export-secret"),
    "export-machine",
    "export-user",
    0,
    "excluded-did",
    100,
  );
  db.close(false);
  const expected = [
    {
      token_sha256: hash("export-secret"),
      machine_id: "export-machine",
      user_id: "export-user",
      revoked_at: 0,
    },
  ];
  expect(exportIdentities(path)).toEqual(expected);
  const previous = console.log;
  const output: string[] = [];
  console.log = (value: string) => {
    output.push(value);
  };
  try {
    expect(await main(["identities-export", "--db", path])).toBe(0);
  } finally {
    console.log = previous;
  }
  expect(JSON.parse(output.join(""))).toEqual(expected);
  expect(output.join("")).not.toContain("export-secret");
  const missing = join(f.root, "absent.db");
  expect(() => exportIdentities(missing)).toThrow();
  expect(existsSync(missing)).toBe(false);
  expect(await Bun.file(path).exists()).toBe(true);
});
