import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  countRanges,
  replayOutboxes,
  resolveReplayModule,
} from "./replay-native-capture-outboxes.mjs";

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), "native-replay-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const write = async (relative, value) => {
    const file = path.join(home, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
    return file;
  };
  await write(".joelclaw/auth.json", {
    machine_id: "fixture",
    user_id: "user",
    token: "fixture-token",
  });
  const env = { HOME: home, JOELCLAW_SESSION_CAPTURE_URL: "https://central.invalid" };
  return { home, write, env };
}

async function installedStub(f, code) {
  const root = path.join(f.home, "releases", "current");
  await f.write("releases/current/package.json", { type: "module" });
  await f.write("releases/current/owner/raw-capture.js", code);
  await mkdir(path.join(root, "pi", "memory-capture"), { recursive: true });
  await mkdir(path.join(f.home, ".pi", "agent", "extensions"), { recursive: true });
  await symlink(
    path.join(root, "pi", "memory-capture"),
    path.join(f.home, ".pi", "agent", "extensions", "memory-capture"),
  );
  return root;
}

const healthy = () => Response.json({ service: "system-bus", status: "running" });

test("dry count reads only range metadata, never imports or runs the release", async (t) => {
  const f = await fixture(t);
  await installedStub(f, "throw new Error('must not import on dry count')");
  const range = ".joelclaw/capture/fixture/pi/outbox-ranges/range-" + "a".repeat(64) + ".json";
  const value = {
    schemaVersion: 2,
    fromOffset: 10,
    toOffset: 40,
    mode: "waiting",
    nextAttemptAt: 0,
  };
  await f.write(range, value);
  const legacy = await f.write(
    ".joelclaw/capture/fixture/pi/outbox/pending-legacy.json",
    "do not read or change",
  );
  const result = await replayOutboxes({
    ...f,
    fetchImpl: () => {
      throw new Error("must not call Central");
    },
  });
  assert.equal(result.mode, "dry-run");
  assert.deepEqual(result.before, {
    ranges: 1,
    waiting: 1,
    ready: 0,
    poisoned: 0,
    invalid: 0,
    due: 1,
    bytes: 30,
  });
  assert.deepEqual(JSON.parse(await readFile(path.join(f.home, range), "utf8")), value);
  assert.equal(await readFile(legacy, "utf8"), "do not read or change");
});

test("resolves the live Pi target, not a stale install manifest, and respects per-call budgets", async (t) => {
  const f = await fixture(t);
  await f.write(".joelclaw/memory-hooks/manifests/pi.json", { fragmentRef: "stale-release" });
  await installedStub(
    f,
    `let calls = 0;
    export const resolveCaptureEndpoint = () => ({url:'https://central.invalid'});
    export async function replayNativeRunCaptureOutboxes({home,env}) {
      if (home !== env.HOME) throw new Error('wrong HOME');
      calls++;
      return {accepted:calls < 3 ? 2 : 0, attempted:calls < 3 ? 2 : 0, failed:0, invalid:0, stale:0};
    }`,
  );
  const result = await replayOutboxes({ ...f, apply: true, calls: 10, fetchImpl: healthy });
  assert.equal(result.invocations, 3);
  assert.equal(result.accepted, 4);
});

test("fails closed when Central is unhealthy or the release API is absent", async (t) => {
  const f = await fixture(t);
  await installedStub(
    f,
    `export const resolveCaptureEndpoint = () => ({url:'https://central.invalid'});
    export async function replayNativeRunCaptureOutboxes() {throw new Error('must not replay');}`,
  );
  await assert.rejects(
    replayOutboxes({ ...f, apply: true, fetchImpl: () => new Response("down", { status: 503 }) }),
    /health gate/,
  );
  await assert.rejects(
    replayOutboxes({
      ...f,
      apply: true,
      fetchImpl: () => Response.json({ service: "unrelated", status: "running" }),
    }),
    /health gate/,
  );
  const root = path.join(f.home, "missing-api");
  await f.write("missing-api/package.json", { type: "module" });
  await f.write("missing-api/owner/raw-capture.js", "export const unrelated = true;");
  await assert.rejects(resolveReplayModule(f.home, root), /does not export/);
  await assert.rejects(replayOutboxes({ ...f, calls: 0 }), /between 1 and 100/);
});

test("stops after a failed release receipt instead of hammering retries", async (t) => {
  const f = await fixture(t);
  await installedStub(
    f,
    `export const resolveCaptureEndpoint = () => ({url:'https://central.invalid'});
    export async function replayNativeRunCaptureOutboxes() {return {accepted:0, attempted:1, failed:1, invalid:0, stale:0};}`,
  );
  const result = await replayOutboxes({ ...f, apply: true, calls: 100, fetchImpl: healthy });
  assert.equal(result.invocations, 1);
  assert.equal(result.failed, 1);
});

test("scheduled replay is off by default and a replay failure still runs both backfills", async (t) => {
  const f = await fixture(t);
  const log = path.join(f.home, "calls.log");
  const bun = await f.write(
    "bin/bun",
    '#!/usr/bin/env bash\nprintf "backfill:%s\\n" "$*" >> "$CALL_LOG"\n',
  );
  const node = await f.write(
    "bin/node",
    '#!/usr/bin/env bash\nprintf "replay:%s\\n" "$*" >> "$CALL_LOG"\nexit 17\n',
  );
  await f.write("bin/curl", '#!/usr/bin/env bash\nprintf "401"\n');
  const { chmod } = await import("node:fs/promises");
  for (const file of [bun, node, path.join(f.home, "bin", "curl")]) await chmod(file, 0o755);
  const env = {
    ...process.env,
    HOME: f.home,
    BUN_BIN: bun,
    NODE_BIN: node,
    CALL_LOG: log,
    PATH: `${path.join(f.home, "bin")}:${process.env.PATH}`,
    JOELCLAW_NATIVE_CAPTURE_REPLAY_ENABLED: "0",
    JOELCLAW_OPENCODE_RAW_SWEEP_ENABLED: "0",
    JOELCLAW_GROK_FILESYSTEM_FALLBACK_ENABLED: "0",
  };
  const script = path.join(import.meta.dirname, "capture-native-sessions.sh");
  const off = spawnSync("bash", [script, "--apply"], { env, encoding: "utf8" });
  assert.equal(off.status, 0, off.stderr);
  let lines = (await readFile(log, "utf8")).trim().split("\n");
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes("--runtime cursor"));
  assert.ok(lines[1].includes("--runtime grok"));
  await writeFile(log, "");
  const enabled = spawnSync("bash", [script, "--apply"], {
    env: { ...env, JOELCLAW_NATIVE_CAPTURE_REPLAY_ENABLED: "1" },
    encoding: "utf8",
  });
  assert.equal(enabled.status, 17, enabled.stderr);
  lines = (await readFile(log, "utf8")).trim().split("\n");
  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith("replay:") && lines[0].includes("--apply --calls 1"));
  assert.ok(lines[1].includes("--runtime cursor"));
  assert.ok(lines[2].includes("--runtime grok"));
});

test(
  "real installed release: scratch HOME ranges in, bounded accepted counts out",
  {
    skip:
      !process.env.NATIVE_CAPTURE_TEST_RELEASE_DIR &&
      "set NATIVE_CAPTURE_TEST_RELEASE_DIR to test an installed release",
  },
  async (t) => {
    const f = await fixture(t);
    const releaseDir = process.env.NATIVE_CAPTURE_TEST_RELEASE_DIR;
    const module = await import(
      pathToFileURL(path.join(releaseDir, "owner", "raw-capture.js")).href
    );
    const sourceRoot = path.join(f.home, "sources");
    const oldRoot = process.env.JOELCLAW_FLOWING_MEMORY_PI_SOURCE_ROOT;
    process.env.JOELCLAW_FLOWING_MEMORY_PI_SOURCE_ROOT = sourceRoot;
    t.after(() => {
      if (oldRoot === undefined) delete process.env.JOELCLAW_FLOWING_MEMORY_PI_SOURCE_ROOT;
      else process.env.JOELCLAW_FLOWING_MEMORY_PI_SOURCE_ROOT = oldRoot;
    });
    for (let i = 0; i < 3; i++) {
      const transcriptPath = await f.write(
        `sources/session-${i}.jsonl`,
        '{"type":"user","message":"fixture"}\n',
      );
      const wake = {
        schemaVersion: 1,
        close: false,
        eventId: `event-${i}`,
        eventName: "turn_end",
        incarnationId: `incarnation-${i}`,
        occurredAt: new Date().toISOString(),
        runtime: "pi",
        sessionId: `session-${i}`,
        transcriptPath,
      };
      const result = await module.captureNativeRun(wake, {
        home: f.home,
        env: f.env,
        fetch: async () => new Response("down", { status: 503 }),
      });
      assert.equal(result.status, "degraded");
    }
    const rangeDir = path.join(f.home, ".joelclaw", "capture", "fixture", "pi", "outbox-ranges");
    for (const name of await readdir(rangeDir)) {
      const file = path.join(rangeDir, name);
      const range = JSON.parse(await readFile(file, "utf8"));
      range.nextAttemptAt = 0; // Only the generated scratch ranges, not the real outbox.
      await writeFile(file, JSON.stringify(range));
    }
    const legacy = await f.write(
      ".joelclaw/capture/fixture/pi/outbox/pending-legacy.json",
      "untouched legacy fixture",
    );
    const fetchImpl = async (url, options) => {
      if (!options?.method) return healthy();
      assert.equal(
        options.headers.Authorization ?? options.headers.authorization,
        "Bearer fixture-token",
      );
      const body = JSON.parse(options.body);
      return Response.json({ status: "accepted", run_id: body.run_id, to_offset: body.to_offset });
    };
    assert.equal((await countRanges(f.home, f.env)).ranges, 3);
    const first = await replayOutboxes({ ...f, releaseDir, apply: true, fetchImpl });
    assert.equal(first.accepted, 2); // The release's two-window budget, not a caller loop.
    assert.equal(first.after.ranges, 1);
    const second = await replayOutboxes({ ...f, releaseDir, apply: true, fetchImpl });
    assert.equal(second.accepted, 1);
    assert.equal(second.after.ranges, 0);
    const empty = await replayOutboxes({ ...f, releaseDir, apply: true, fetchImpl });
    assert.equal(empty.attempted, 0);
    assert.equal(await readFile(legacy, "utf8"), "untouched legacy fixture");
  },
);
