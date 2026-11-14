import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  classifyCapture,
  flushReconcileAlarms,
  openReconcileSource,
  openReconcileState,
  reconcileCaptures,
  assertSeparateReconcilePaths,
} from "../src/reconcile.mjs";
import {
  createPostgresLookup,
  createReconcileSender,
  createReconcileTelemetry,
  runReadOnlyPsql,
  reconcilePostgresEnv,
  main,
} from "../src/reconcile-cli.mjs";

import {
  ReconcileFailure,
  redactedPsqlLine,
  logReconcileFailure,
} from "../src/reconcile-error.mjs";

// Only generated fixtures. No live endpoints or real capture paths. The optional
// PG test reads only CAPTURE_RECONCILE_TEST_PG_BIN to locate fixture binaries.
// Keep fixture roots for inspection; the test caller owns reversible cleanup.
const handles = [];
afterEach(() => {
  for (const db of handles.splice(0)) db.close();
});
const track = (db) => {
  handles.push(db);
  return db;
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "capture-reconcile-"));
  const cellPath = join(root, "outbox.db"),
    indexPath = join(root, "sessions.db");
  const statePath = join(root, "reconcile.db");
  const cellWriter = track(new DatabaseSync(cellPath));
  cellWriter.exec(`CREATE TABLE captured(run_id TEXT PRIMARY KEY,arrival_seq INTEGER,payload_json TEXT,arrived_at INTEGER);
    CREATE TABLE verdicts(run_id TEXT PRIMARY KEY,verdict TEXT,decided_at INTEGER);
    CREATE TABLE run_capture_retry(key TEXT PRIMARY KEY,state TEXT);`);
  const indexWriter = track(new DatabaseSync(indexPath));
  indexWriter.exec(
    "CREATE TABLE runs(run_id TEXT PRIMARY KEY); CREATE TABLE skipped_runs(run_id TEXT PRIMARY KEY)",
  );
  const cell = track(openReconcileSource(cellPath)),
    index = track(openReconcileSource(indexPath));
  const state = track(openReconcileState(statePath));
  let now = 2_000_000,
    sequence = 0;
  const sends = [],
    events = [],
    logs = [],
    lookups = [];
  const telemetry = { emit: (action, detail, extra) => events.push({ action, detail, ...extra }) };
  const deps = {
    cell,
    index,
    state,
    now: () => now,
    apply: true,
    telemetry,
    load: () => 0,
    log: (line) => logs.push(line),
    lookup: async (ids) => {
      lookups.push(ids);
      return [];
    },
    send: async (event) => {
      sends.push(event);
    },
  };
  function capture(id = `fixture-${++sequence}`) {
    const bytes = Buffer.from(`{"fixture":"${id}"}\n`);
    const data = {
      run_id: id,
      user_id: "fixture-user",
      machine_id: "fixture-machine",
      agent_runtime: "pi",
      jsonl_path: join(root, `${id}.jsonl`),
      jsonl_bytes: bytes.length,
      jsonl_sha256: createHash("sha256").update(bytes).digest("hex"),
      started_at: 1,
    };
    writeFileSync(data.jsonl_path, bytes);
    cellWriter
      .prepare("INSERT INTO captured VALUES (?,?,?,?)")
      .run(id, ++sequence, JSON.stringify(data), now - 660_000);
    cellWriter.prepare("INSERT INTO verdicts VALUES (?,'appended',?)").run(id, now - 660_000);
    return data;
  }
  return {
    root,
    cellPath,
    indexPath,
    statePath,
    cellWriter,
    indexWriter,
    state,
    deps,
    sends,
    events,
    logs,
    lookups,
    telemetry,
    capture,
    tick: () => {
      now += 600_001;
    },
    row: (id) => state.prepare("SELECT * FROM reconcile_runs WHERE run_id=?").get(id),
    pass: (overrides = {}) => reconcileCaptures({ ...deps, ...overrides }),
  };
}

// Required test 1: a 2xx/sent retry receipt is not proof of indexing.
test("b2a940b9-shaped: sent retry, no PG event, cell payload verified; handled only after indexing", async () => {
  const f = fixture(),
    data = f.capture("b2a940b9-fixture");
  f.cellWriter.prepare("INSERT INTO run_capture_retry VALUES (?,'sent')").run(data.run_id);
  assert.equal((await f.pass()).resent, 1);
  assert.deepEqual(f.sends[0], {
    name: "memory/run.captured",
    data,
    id: `reconcile:${data.run_id}:1`,
  });
  assert.equal(f.row(data.run_id).state, "resent");
  f.indexWriter.prepare("INSERT INTO runs VALUES (?)").run(data.run_id);
  await f.pass();
  assert.equal(f.row(data.run_id).state, "indexed");
  f.tick();
  await f.pass();
  assert.equal(f.sends.length, 1);
});

// Required test 2: prefer the event copy, not a stale cell copy.
test("no function run: use Postgres event_data", async () => {
  const f = fixture(),
    data = f.capture();
  const eventData = { ...data, tags: ["postgres-copy"] };
  await f.pass({
    lookup: async () => [
      { run_id: data.run_id, event_data: JSON.stringify(eventData), has_run: false, status: null },
    ],
  });
  assert.deepEqual(f.sends[0].data, eventData);
});

// Required test 3.
test("Completed chunks_indexed:0 is terminal empty and never resent", async () => {
  const f = fixture(),
    data = f.capture();
  const lookup = async () => [
    { run_id: data.run_id, has_run: true, status: "Completed", output: { chunks_indexed: 0 } },
  ];
  assert.equal((await f.pass({ lookup })).empty, 1);
  assert.equal(f.row(data.run_id).state, "empty");
  assert.ok(f.row(data.run_id).handled_at);
  f.tick();
  await f.pass({
    lookup: async () => {
      assert.fail("handled run must not be queried");
    },
  });
  assert.equal(f.sends.length, 0);
});

test("Completed nonempty waits two hours from first seen, alarms once, never resends and later indexes", async () => {
  const f = fixture(),
    data = f.capture();
  const lookup = async () => [
    { run_id: data.run_id, has_run: true, status: "Completed", output: { chunks_indexed: 4 } },
  ];
  assert.equal((await f.pass({ lookup })).wait_alarmed, 0);
  for (let i = 0; i < 11; i++) f.tick();
  assert.equal((await f.pass({ lookup })).wait_alarmed, 0);
  f.tick();
  assert.equal((await f.pass({ lookup })).wait_alarmed, 1);
  assert.equal(f.row(data.run_id).state, "waiting");
  assert.equal(f.row(data.run_id).wait_alarmed, 1);
  assert.equal(f.row(data.run_id).handled_at, null);
  await flushReconcileAlarms(f.state, f.telemetry, async () => {}, f.deps.log);
  f.tick();
  assert.equal((await f.pass({ lookup })).wait_alarmed, 0);
  await flushReconcileAlarms(f.state, f.telemetry, async () => {}, f.deps.log);
  assert.equal(f.logs.filter((line) => line.startsWith("notifyAgent ")).length, 1);
  assert.equal(
    f.events.filter(
      (event) => event.level === "error" && event.alarm_reason === "wait_ceiling_exceeded",
    ).length,
    1,
  );
  // History expiry or failed duplicates cannot turn an alarmed wait into resend.
  const reopened = track(openReconcileState(f.statePath));
  f.tick();
  await f.pass({ state: reopened, lookup: async () => [] });
  assert.equal(f.row(data.run_id).state, "waiting");
  assert.equal(f.sends.length, 0);
  f.indexWriter.prepare("INSERT INTO runs VALUES (?)").run(data.run_id);
  await f.pass({ state: reopened });
  assert.equal(f.row(data.run_id).state, "indexed");
  assert.equal(f.row(data.run_id).wait_alarmed, 0);
  assert.equal(f.sends.length, 0);
});

test("wait ceiling is configurable, queued runs alarm, and pending alarms survive another pass", async () => {
  const f = fixture(),
    data = f.capture();
  const lookup = async () => [{ run_id: data.run_id, has_run: true, status: null }];
  await f.pass({ lookup, waitAlarmMs: 1 });
  f.tick();
  const counts = await f.pass({ lookup, waitAlarmMs: 1 });
  assert.equal(counts.wait_alarmed, 1);
  assert.equal(counts.gave_up, 0);
  f.tick();
  await f.pass({ lookup, waitAlarmMs: 1 });
  assert.equal(f.row(data.run_id).alarm_reason, "wait_ceiling_exceeded");
  assert.equal(f.row(data.run_id).alarmed_at, null);
  await flushReconcileAlarms(f.state, f.telemetry, async () => {}, f.deps.log);
  assert.equal(f.sends.length, 0);
  await assert.rejects(main([], { RECONCILE_WAIT_ALARM_MS: "0" }), /invalid_configuration/u);
  await assert.rejects(f.pass({ waitAlarmMs: 0 }), /invalid_wait_alarm_ms/u);
});

test("wait latch migration preserves existing receipts and original first-seen time", async () => {
  const f = fixture(),
    data = f.capture();
  await f.pass({ lookup: async () => [{ run_id: data.run_id, has_run: true, status: null }] });
  const before = f.row(data.run_id);
  f.state.exec(
    "ALTER TABLE reconcile_runs DROP COLUMN wait_alarmed; DROP TABLE reconcile_pass_alarm",
  );
  const upgraded = track(openReconcileState(f.statePath));
  const row = upgraded.prepare("SELECT * FROM reconcile_runs WHERE run_id=?").get(data.run_id);
  assert.equal(row.created_at, before.created_at);
  assert.equal(row.state, "waiting");
  assert.equal(row.attempts, before.attempts);
  assert.equal(row.wait_alarmed, 0);
  assert.equal(
    upgraded.prepare("SELECT failed_alarmed FROM reconcile_pass_alarm").get().failed_alarmed,
    0,
  );
});

// Required test 4; alarm delivery is retried if OTEL is unavailable.
test("SHA mismatch: no POST, durable alarm, error OTEL and notifyAgent line", async () => {
  const f = fixture(),
    data = f.capture();
  writeFileSync(data.jsonl_path, Buffer.alloc(data.jsonl_bytes, "x"));
  assert.equal((await f.pass()).gave_up, 1);
  assert.equal(f.sends.length, 0);
  assert.equal(f.row(data.run_id).attempts, 0);
  await assert.rejects(
    flushReconcileAlarms(
      f.state,
      f.telemetry,
      async () => {
        throw Error("fixture-offline");
      },
      f.deps.log,
    ),
  );
  assert.equal(f.row(data.run_id).alarmed_at, null);
  await flushReconcileAlarms(f.state, f.telemetry, async () => {}, f.deps.log);
  assert.ok(f.row(data.run_id).alarmed_at);
  assert.ok(
    f.events.some(
      (event) => event.action === "capture.reconcile.gave_up" && event.level === "error",
    ),
  );
  assert.ok(f.logs.some((line) => line.startsWith("notifyAgent ")));
  f.tick();
  await f.pass();
  assert.equal(f.sends.length, 0);
});

// Required test 5: separate SQLite connections, overlapping asynchronous passes.
test("overlapping passes share a fenced lease and produce one stable-id POST", async () => {
  const f = fixture(),
    data = f.capture();
  const secondState = track(openReconcileState(f.statePath));
  let entered, finish;
  const started = new Promise((accept) => {
    entered = accept;
  });
  const gate = new Promise((accept) => {
    finish = accept;
  });
  const first = f.pass({
    send: async (event) => {
      f.sends.push(event);
      entered();
      await gate;
    },
  });
  await started;
  assert.equal((await f.pass({ state: secondState })).skipped, "locked");
  finish();
  await first;
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].id, `reconcile:${data.run_id}:1`);
  assert.equal((await f.pass()).resent, 0);
});

// Required test 6.
test("1-minute load over 40 skips without reading PG, sends or state writes", async () => {
  const f = fixture();
  f.capture();
  const before = readFileSync(f.statePath);
  const result = await f.pass({
    load: () => 40.01,
    lookup: async () => {
      assert.fail("load gate must run first");
    },
  });
  assert.equal(result.skipped, "load");
  assert.ok(f.logs.includes("capture.reconcile.skipped reason=load"));
  assert.deepEqual(readFileSync(f.statePath), before);
  assert.equal(f.sends.length, 0);
});

// Required test 7: both bounds, including the terminal alarm.
test("N resends per pass, remainder next pass; three attempts then alarm", async () => {
  const f = fixture();
  const data = Array.from({ length: 5 }, () => f.capture());
  assert.equal((await f.pass({ limit: 2 })).resent, 2);
  assert.equal((await f.pass({ limit: 2 })).resent, 2);
  assert.equal((await f.pass({ limit: 2 })).resent, 1);
  assert.equal(new Set(f.sends.map((event) => event.data.run_id)).size, 5);
  for (let attempt = 2; attempt <= 3; attempt++) {
    f.tick();
    assert.equal((await f.pass()).resent, 5);
  }
  f.tick();
  assert.equal((await f.pass()).gave_up, 5);
  assert.equal(f.sends.length, 15);
  assert.ok(data.every((capture) => f.row(capture.run_id).attempts === 3));
  await flushReconcileAlarms(f.state, f.telemetry, async () => {}, f.deps.log);
  assert.equal(f.logs.filter((line) => line.startsWith("notifyAgent ")).length, 5);
  f.tick();
  assert.equal((await f.pass()).resent, 0);
});

test("queued/running, completed nonempty, duplicate finishes and failed runs classify safely", async () => {
  assert.equal(classifyCapture([{ has_run: true, status: null }]), "waiting");
  assert.equal(classifyCapture([{ has_run: true, status: "Running" }]), "waiting");
  assert.equal(
    classifyCapture([{ has_run: true, status: "Completed", output: { chunks_indexed: 9 } }]),
    "waiting",
  );
  assert.equal(classifyCapture([{ has_run: false }, { has_run: true, status: null }]), "waiting");
  assert.equal(classifyCapture([{ has_run: true, status: "Failed" }]), "missing_run");
  const f = fixture(),
    data = f.capture();
  const result = await f.pass({
    lookup: async () => [{ run_id: data.run_id, has_run: true, status: null }],
  });
  assert.equal(result.waiting, 1);
  assert.equal(f.sends.length, 0);
  assert.equal(f.row(data.run_id).classification, "waiting");
});

test("missing blob and byte mismatch both alarm, even when Postgres has data", async () => {
  const f = fixture(),
    a = f.capture(),
    b = f.capture();
  const missing = { ...a, jsonl_path: join(f.root, "never-created.jsonl") };
  const wrongSize = { ...b, jsonl_bytes: b.jsonl_bytes + 1 };
  const result = await f.pass({
    lookup: async () =>
      [missing, wrongSize].map((data) => ({
        run_id: data.run_id,
        event_data: data,
        has_run: false,
        status: null,
      })),
  });
  assert.equal(result.gave_up, 2);
  assert.equal(f.sends.length, 0);
});

test("skipped_runs is handled; fresh captures and non-appended verdicts are ineligible", async () => {
  const f = fixture(),
    skipped = f.capture(),
    fresh = f.capture(),
    conflict = f.capture();
  f.indexWriter.prepare("INSERT INTO skipped_runs VALUES (?)").run(skipped.run_id);
  f.cellWriter
    .prepare("UPDATE captured SET arrived_at=? WHERE run_id=?")
    .run(f.deps.now() - 599_999, fresh.run_id);
  f.cellWriter
    .prepare("UPDATE verdicts SET verdict='conflict' WHERE run_id=?")
    .run(conflict.run_id);
  await f.pass();
  assert.equal(f.row(skipped.run_id).state, "indexed");
  assert.equal(f.sends.length, 0);
  assert.equal(f.lookups.length, 0);
});

test("unknown HTTP results reuse reserved id and immutable payload, but still stop after 3 sends", async () => {
  const f = fixture(),
    data = f.capture();
  const send = async (event) => {
    f.sends.push(event);
    throw Error("fixture-timeout");
  };
  await f.pass({ send });
  assert.equal(f.row(data.run_id).state, "sending");
  for (let i = 0; i < 2; i++) {
    f.tick();
    await f.pass({
      send,
      lookup: async () => [
        {
          run_id: data.run_id,
          has_run: false,
          event_data: { ...data, tags: ["changed-must-not-use"] },
          status: null,
        },
      ],
    });
  }
  assert.deepEqual(
    f.sends.map((event) => event.id),
    Array(3).fill(`reconcile:${data.run_id}:1`),
  );
  assert.deepEqual(f.sends[1].data, data);
  f.tick();
  assert.equal((await f.pass({ send })).gave_up, 1);
  assert.equal(f.sends.length, 3);
});

test("failed POSTs consume the pass ceiling but do not inflate resent counts", async () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) f.capture();
  const result = await f.pass({
    limit: 2,
    send: async () => {
      throw Error("fixture-offline");
    },
  });
  assert.equal(result.attempted, 2);
  assert.equal(result.failed, 2);
  assert.equal(result.resent, 0);
  assert.equal(f.logs.filter((line) => line.startsWith("capture.reconcile.failed")).length, 1);
});

test("an expired lease recovers a crash-reserved attempt with the same id", async () => {
  const f = fixture(),
    data = f.capture();
  const event = { name: "memory/run.captured", data, id: `reconcile:${data.run_id}:1` };
  f.state
    .prepare(`INSERT INTO reconcile_runs
    (run_id,state,attempts,classification,event_json,created_at,updated_at)
    VALUES (?,'sending',1,'missing_event',?,?,?)`)
    .run(data.run_id, JSON.stringify(event), 1, 1);
  f.state.exec("UPDATE reconcile_lease SET owner='crashed',expires_at=1");
  await f.pass();
  assert.deepEqual(f.sends, [event]);
  assert.equal(f.row(data.run_id).attempts, 2);
});

test("PG failure is not absence; dry-run and source handles never mutate source databases", async () => {
  const f = fixture();
  f.capture();
  const beforeCell = readFileSync(f.cellPath),
    beforeIndex = readFileSync(f.indexPath);
  await assert.rejects(
    f.pass({
      lookup: async () => {
        throw Error("fixture-pg-unavailable");
      },
    }),
  );
  assert.equal(f.sends.length, 0);
  assert.equal(f.state.prepare("SELECT count(*) AS n FROM reconcile_runs").get().n, 0);
  assert.equal((await f.pass({ apply: false })).would_resend, 1);
  assert.equal(f.state.prepare("SELECT count(*) AS n FROM reconcile_runs").get().n, 0);
  assert.deepEqual(readFileSync(f.cellPath), beforeCell);
  assert.deepEqual(readFileSync(f.indexPath), beforeIndex);
  assert.throws(() => f.deps.index.exec("INSERT INTO runs VALUES ('not-allowed')"), /readonly/iu);
  assert.equal(statSync(f.statePath).mode & 0o777, 0o600);
  assert.throws(() => assertSeparateReconcilePaths(f.cellPath, f.indexPath, f.cellPath));
});

test("PG adapter batches, filters function, bounds received_at and requires read-only transaction", async () => {
  const functionId = "00000000-0000-4000-8000-000000000001";
  const lookup = createPostgresLookup({ INNGEST_CAPTURE_FUNCTION_ID: functionId }, async (sql) => {
    assert.match(sql, /^BEGIN TRANSACTION READ ONLY;/u);
    assert.match(sql, /\\copy \(/u);
    assert.match(sql, /received_at > now\(\) - interval '2 days'/u);
    assert.match(sql, /ANY\(ARRAY\['one','two'\]::text\[\]\)/u);
    assert.ok(sql.includes(functionId));
    assert.match(sql, /COMMIT;/u);
    return Buffer.from(
      JSON.stringify([
        {
          run_id: "one",
          event_data: "{}",
          has_run: true,
          status: "Completed",
          output: '{"chunks_indexed":0}',
        },
      ]),
    ).toString("base64");
  });
  assert.equal((await lookup(["one", "two"]))[0].output.chunks_indexed, 0);
  await assert.rejects(lookup(["sql'injection"]));
  const broken = createPostgresLookup({ INNGEST_CAPTURE_FUNCTION_ID: functionId }, async () => "");
  await assert.rejects(broken(["one"]));
});

function psqlFailure(
  stderr = "ERROR:  operator does not exist: character = uuid\nLINE 1: SELECT private_sql",
  exit = 3,
) {
  return runReadOnlyPsql(
    "SELECT private_sql;",
    { INNGEST_POSTGRES_URI: "postgresql://fixture:private-password@private.invalid/private-db" },
    (_bin, argv, options, callback) => {
      assert.ok(!JSON.stringify(argv).includes("private"));
      assert.equal(options.env.PGPASSWORD, "private-password");
      queueMicrotask(() =>
        callback(Object.assign(new Error("private DSN and SQL"), { code: exit }), "", stderr),
      );
      return { stdin: { on() {}, end() {} } };
    },
  );
}

test("psql fixture retains exit and first diagnostic, never SQL, connection values or raw error", async () => {
  const f = fixture();
  f.capture();
  await assert.rejects(f.pass({ lookup: () => psqlFailure() }), (error) => {
    assert.deepEqual(error.failure, {
      stage: "pg",
      exit: 3,
      stderr: "ERROR: operator does not exist: character = uuid",
    });
    return true;
  });
  const lines = f.logs.filter((line) => line.startsWith("capture.reconcile.failed"));
  assert.deepEqual(lines, [
    'capture.reconcile.failed stage="pg" exit=3 stderr="ERROR: operator does not exist: character = uuid"',
  ]);
  const output = JSON.stringify({
    logs: f.logs,
    events: f.events,
    alarm: f.state.prepare("SELECT * FROM reconcile_pass_alarm").get(),
  });
  assert.doesNotMatch(output, /private|SELECT|LINE 1|postgresql/u);
  assert.equal(f.sends.length, 0);
  for (const [stderr, expected] of [
    [
      'ERROR: column "private-token" does not exist\nSELECT private_sql',
      "ERROR: column [redacted] does not exist",
    ],
    [
      'psql: error: connection to server at "private.invalid" (10.0.0.1), port 5432 failed: password=secret',
      "psql: connection to server [redacted]",
    ],
    [
      'FATAL: password authentication failed for user "private-user"',
      "FATAL: password authentication failed for user [redacted]",
    ],
    ['ERROR: syntax error at or near "private-token"', "ERROR: syntax error at or near [redacted]"],
    [
      'ERROR: invalid input syntax for type uuid: "private-value"',
      "ERROR: invalid input syntax for type uuid [redacted]",
    ],
    [
      'psql: error: could not translate host name "private.invalid" to address: private-error',
      "psql: error: could not translate host name [redacted]",
    ],
    ["ERROR: operator does not exist: character = uuid; private-token", "ERROR: [redacted]"],
    ["ERROR: operator does not exist: character = uuid\rprivate-token", "ERROR: [redacted]"],
    ["postgresql://user:secret@private.invalid/db SELECT * FROM captures", "[redacted]"],
    ["ERROR: operator does not exist: private_type = uuid", "ERROR: [redacted]"],
    ["", "[unavailable]"],
  ])
    assert.equal(redactedPsqlLine(stderr), expected);
  await assert.rejects(psqlFailure("secret", "ENOENT"), (error) => error.failure.exit === null);
});

test("CLI psql fixture prints one redacted failure line and exits nonzero without live reads", () => {
  const f = fixture();
  f.capture();
  const fakePsql = join(f.root, "psql");
  writeFileSync(
    fakePsql,
    `#!${process.execPath}\nprocess.stdin.resume();\nprocess.stdin.on('end', () => {\n  process.stderr.write('ERROR:  column "private-password@private.invalid" does not exist\\nLINE 1: SELECT private_sql\\n');\n  process.exitCode = 3;\n});\n`,
    { mode: 0o700 },
  );
  const env = {
    PATH: f.root,
    HOME: f.root,
    CAPTURE_CELL_DB: f.cellPath,
    SESSION_INDEX_PATH: f.indexPath,
    CAPTURE_RECONCILE_DB: f.statePath,
    INNGEST_CAPTURE_FUNCTION_ID: "00000000-0000-4000-8000-000000000001",
    INNGEST_POSTGRES_URI: "postgresql://fixture:private-password@private.invalid/private-db",
  };
  const cli = fileURLToPath(new URL("../src/reconcile-cli.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "--dry-run", "--load-limit", "10000"], {
    env,
    encoding: "utf8",
    timeout: 15000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  const output = result.stdout + result.stderr;
  const lines = output.split("\n").filter((line) => line.startsWith("capture.reconcile.failed"));
  assert.deepEqual(lines, [
    'capture.reconcile.failed stage="pg" exit=3 stderr="ERROR: column [redacted] does not exist"',
  ]);
  assert.doesNotMatch(output, /private|SELECT|LINE 1|postgresql/u);
  assert.equal(
    f.state.prepare("SELECT failed_alarmed FROM reconcile_pass_alarm").get().failed_alarmed,
    0,
  );
  const config = spawnSync(process.execPath, [cli, "--unknown-private"], {
    env: { PATH: f.root, HOME: f.root },
    encoding: "utf8",
    timeout: 15000,
  });
  assert.ifError(config.error);
  assert.equal(config.status, 1);
  assert.equal(config.stderr.trim(), 'capture.reconcile.failed stage="config" status=null');
});

test("failed-pass alarm is durable and once-only over two failures, clears on success, then rearms", async () => {
  const f = fixture();
  const data = f.capture();
  const fail = { lookup: () => psqlFailure() };
  await assert.rejects(f.pass(fail));
  await flushReconcileAlarms(f.state, f.telemetry, async () => {}, f.deps.log);
  const reopened = track(openReconcileState(f.statePath));
  await assert.rejects(f.pass({ ...fail, state: reopened }));
  await flushReconcileAlarms(reopened, f.telemetry, async () => {}, f.deps.log);
  const pages = () => f.logs.filter((line) => line.startsWith("notifyAgent "));
  const alarms = () => f.events.filter((event) => event.alarm_reason === "pass_failed");
  assert.equal(pages().length, 1);
  assert.equal(alarms().length, 1);
  assert.equal(alarms()[0].stage, "pg");
  assert.equal(
    f.state.prepare("SELECT failed_alarmed FROM reconcile_pass_alarm").get().failed_alarmed,
    1,
  );
  // Load/lease skips are not successful passes and must not clear the latch.
  await f.pass({ load: () => 41 });
  f.state.exec("UPDATE reconcile_lease SET owner='fixture-other',expires_at=99999999 WHERE id=1");
  assert.equal((await f.pass()).skipped, "locked");
  f.state.exec("UPDATE reconcile_lease SET expires_at=0 WHERE id=1");
  assert.equal(
    f.state.prepare("SELECT failed_alarmed FROM reconcile_pass_alarm").get().failed_alarmed,
    1,
  );
  await f.pass({ lookup: async () => [{ run_id: data.run_id, has_run: true, status: null }] });
  const cleared = f.state.prepare("SELECT * FROM reconcile_pass_alarm").get();
  assert.equal(cleared.failed_alarmed, 0);
  assert.equal(cleared.alarmed_at, null);
  assert.equal(cleared.failure_json, null);
  f.tick();
  await assert.rejects(f.pass(fail));
  await flushReconcileAlarms(f.state, f.telemetry, async () => {}, f.deps.log);
  assert.equal(pages().length, 2);
  assert.equal(alarms().length, 2);
  assert.equal(f.sends.length, 0);
});

test("failed-pass alarm receipt waits for successful telemetry; dry-run never latches", async () => {
  const f = fixture();
  f.capture();
  const fail = { lookup: () => psqlFailure() };
  await assert.rejects(f.pass({ ...fail, apply: false }));
  assert.equal(
    f.state.prepare("SELECT failed_alarmed FROM reconcile_pass_alarm").get().failed_alarmed,
    0,
  );
  await assert.rejects(f.pass(fail));
  await assert.rejects(
    flushReconcileAlarms(
      f.state,
      f.telemetry,
      async () => {
        throw Error("fixture-offline");
      },
      f.deps.log,
    ),
  );
  assert.equal(
    f.state.prepare("SELECT alarmed_at FROM reconcile_pass_alarm").get().alarmed_at,
    null,
  );
  await assert.rejects(f.pass(fail));
  await flushReconcileAlarms(f.state, f.telemetry, async () => {}, f.deps.log);
  assert.ok(f.state.prepare("SELECT alarmed_at FROM reconcile_pass_alarm").get().alarmed_at);
  const count = f.logs.length;
  await flushReconcileAlarms(f.state, f.telemetry, async () => {}, f.deps.log);
  assert.equal(f.logs.length, count);
});

test("index errors and HTTP failures keep their stage; POST failures log once and latch without changing retry ids", async () => {
  const f = fixture();
  const data = f.capture();
  const env = { INNGEST_BASE_URL: "https://private.invalid", INNGEST_EVENT_KEY: "private-key" };
  const send = createReconcileSender(
    env,
    async () => new Response("private body", { status: 503 }),
  );
  assert.equal((await f.pass({ send })).failed, 1);
  f.tick();
  assert.equal((await f.pass({ send })).failed, 1);
  await flushReconcileAlarms(f.state, f.telemetry, async () => {}, f.deps.log);
  assert.equal(
    f.logs.filter((line) => line === 'capture.reconcile.failed stage="post" status=503').length,
    2,
  );
  assert.equal(f.logs.filter((line) => line.startsWith("notifyAgent ")).length, 1);
  assert.equal(JSON.parse(f.row(data.run_id).event_json).id, `reconcile:${data.run_id}:1`);
  assert.doesNotMatch(JSON.stringify(f.events), /private/u);
  f.indexWriter.exec("DROP TABLE runs");
  await assert.rejects(f.pass(), (error) => error.failure.stage === "index");
  assert.ok(f.logs.includes('capture.reconcile.failed stage="index" status=null'));
  const lines = [];
  await assert.rejects(
    createReconcileSender(env, async () => {
      throw Error("https://user:secret@private.invalid");
    })({}),
    (error) => {
      logReconcileFailure(error, (line) => lines.push(line));
      return true;
    },
  );
  assert.deepEqual(lines, ['capture.reconcile.failed stage="post" status=null']);
  await assert.rejects(
    createReconcileSender(env, async () => Response.json({}))({}),
    (error) => error.failure.status === 200,
  );
  const { telemetry, flush } = createReconcileTelemetry(
    { OTEL_EMIT_URL: "https://private.invalid/emit" },
    true,
    () => {},
    async () => new Response(null, { status: 401 }),
  );
  telemetry.emit("capture.reconcile.found", "fixture");
  await assert.rejects(
    flush(),
    (error) => error.failure.stage === "post" && error.failure.status === 401,
  );
});

test("a lost lease cannot hide the original psql failure or write an unfenced alarm", async () => {
  const f = fixture();
  f.capture();
  await assert.rejects(
    f.pass({
      lookup: async () => {
        f.state.exec("UPDATE reconcile_lease SET expires_at=0 WHERE id=1");
        return psqlFailure();
      },
    }),
    (error) => error.failure.stage === "pg" && error.failure.exit === 3,
  );
  assert.equal(f.logs.filter((line) => line.startsWith("capture.reconcile.failed")).length, 1);
  assert.ok(f.logs.includes("capture.reconcile.alarm_persist_failed"));
  assert.equal(
    f.state.prepare("SELECT failed_alarmed FROM reconcile_pass_alarm").get().failed_alarmed,
    0,
  );
});

test("config and malformed PG failures expose only a safe class, not dependency messages", async () => {
  await assert.rejects(
    runReadOnlyPsql("SELECT private", { INNGEST_POSTGRES_URI: "not-a-uri-secret" }),
    (error) => {
      assert.equal(error.failure.stage, "config");
      assert.doesNotMatch(JSON.stringify(error), /secret|SELECT/u);
      return true;
    },
  );
  const lookup = createPostgresLookup(
    { INNGEST_CAPTURE_FUNCTION_ID: "00000000-0000-4000-8000-000000000001" },
    async () => Buffer.from("private malformed json").toString("base64"),
  );
  await assert.rejects(lookup(["fixture"]), (error) => error.failure.stage === "pg");
  assert.equal(new ReconcileFailure("unknown").failure.stage, "config");
});

test(
  "real PG fixture: COPY decoding, function filter, lookback and read-only session",
  {
    skip: !process.env.CAPTURE_RECONCILE_TEST_PG_BIN,
  },
  async () => {
    const bin = process.env.CAPTURE_RECONCILE_TEST_PG_BIN;
    const root = mkdtempSync(join(tmpdir(), "capture-pg-"));
    const dataDir = join(root, "data");
    const functionId = "00000000-0000-4000-8000-000000000001";
    execFileSync(
      join(bin, "initdb"),
      ["-D", dataDir, "-U", "fixture", "-A", "trust", "--no-sync", "--locale=C"],
      { stdio: "pipe", timeout: 15000 },
    );
    // Unix socket only, in this fixture's private directory. No TCP listener.
    execFileSync(
      join(bin, "pg_ctl"),
      [
        "-D",
        dataDir,
        "-l",
        join(root, "server.log"),
        "-o",
        `-k '${root}' -h '' -c fsync=off`,
        "-w",
        "start",
      ],
      { stdio: "pipe", timeout: 15000 },
    );
    try {
      const psql = (sql) =>
        execFileSync(
          join(bin, "psql"),
          ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-h", root, "-U", "fixture", "-d", "postgres"],
          { input: sql, stdio: "pipe", timeout: 15000 },
        );
      psql(`CREATE TABLE events(internal_id bytea,event_name text,event_data text,received_at timestamp);
      CREATE TABLE function_runs(run_id bytea,event_id bytea,function_id character(36));
      CREATE TABLE function_finishes(run_id bytea,status text,output text,created_at timestamp);
      INSERT INTO events VALUES (decode('01','hex'),'memory/run.captured','{"run_id":"one","tags":["tab\\tline\\nslash\\\\"]}',now());
      INSERT INTO events VALUES (decode('02','hex'),'memory/run.captured','{"run_id":"old"}',now()-interval '3 days');
      INSERT INTO events VALUES (decode('03','hex'),'memory/run.captured','{"run_id":"other"}',now());
      INSERT INTO function_runs VALUES (decode('11','hex'),decode('01','hex'),'${functionId}');
      INSERT INTO function_runs VALUES (decode('13','hex'),decode('03','hex'),'00000000-0000-4000-8000-000000000002');
      INSERT INTO function_finishes VALUES (decode('11','hex'),'Completed','{"chunks_indexed":0}',now());`);
      const env = {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: root,
        INNGEST_POSTGRES_URI: `postgresql:///postgres?host=${encodeURIComponent(root)}&user=fixture`,
        INNGEST_CAPTURE_FUNCTION_ID: functionId,
      };
      const rows = await createPostgresLookup(env)(["one", "old", "other"]);
      assert.equal(rows.length, 2);
      assert.equal(rows.find((row) => row.run_id === "one").output.chunks_indexed, 0);
      assert.equal(rows.find((row) => row.run_id === "other").has_run, false);
      assert.equal(
        JSON.parse(rows.find((row) => row.run_id === "one").event_data).tags[0],
        "tab\tline\nslash\\",
      );
      await assert.rejects(
        runReadOnlyPsql("INSERT INTO events VALUES (NULL,'forbidden','{}',now());", env),
      );
    } finally {
      execFileSync(join(bin, "pg_ctl"), ["-D", dataDir, "-m", "fast", "-w", "stop"], {
        stdio: "pipe",
        timeout: 15000,
      });
    }
  },
);

test("PG URI maps to explicit env and never inherits default-target settings", () => {
  const env = reconcilePostgresEnv({
    INNGEST_POSTGRES_URI:
      "postgresql://fixture:fake%21@example.invalid:6543/fixturedb?sslmode=require",
    PGHOST: "unwanted.invalid",
    PGSERVICE: "unwanted",
    PGOPTIONS: "unwanted",
  });
  assert.equal(env.PGHOST, "example.invalid");
  assert.equal(env.PGPORT, "6543");
  assert.equal(env.PGDATABASE, "fixturedb");
  assert.equal(env.PGPASSWORD, "fake!");
  assert.equal(env.PGSERVICE, undefined);
  assert.match(env.PGOPTIONS, /default_transaction_read_only=on/u);
  assert.throws(() => reconcilePostgresEnv({ INNGEST_POSTGRES_URI: "postgresql:///postgres" }));
});

test("HTTP adapter uses runtime key, stable envelope, timeout and validates acknowledgement", async () => {
  const env = { INNGEST_BASE_URL: "https://example.invalid", INNGEST_EVENT_KEY: "fixture-key" };
  const event = { name: "memory/run.captured", id: "reconcile:fixture:1", data: {} };
  const send = createReconcileSender(env, async (url, init) => {
    assert.equal(url, "https://example.invalid/e/fixture-key");
    assert.equal(init.redirect, "error");
    assert.ok(init.signal);
    assert.deepEqual(JSON.parse(init.body), event);
    return Response.json({ ids: ["fixture-accepted"] });
  });
  await send(event);
  await assert.rejects(createReconcileSender(env, async () => Response.json({}))(event));
});

test("telemetry adapter flushes pass counts and error level without exposing transport secrets", async () => {
  const posted = [];
  const { telemetry, flush } = createReconcileTelemetry(
    { OTEL_EMIT_URL: "https://example.invalid/emit" },
    true,
    () => {},
    async (_url, init) => {
      posted.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    },
  );
  telemetry.emit("capture.reconcile.found", "Pass", { found: 1, resent: 1 });
  telemetry.emit("capture.reconcile.gave_up", "Alarm", { level: "error", run_id: "fixture" });
  await flush();
  assert.equal(posted[0].metadata.found, 1);
  assert.equal(posted[1].level, "error");
  assert.equal(posted[1].success, false);
});
