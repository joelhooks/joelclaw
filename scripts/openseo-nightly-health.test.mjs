import assert from "node:assert/strict";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assessHeartbeat } from "./openseo-health-deadman.mjs";
import {
  acquireRunLock,
  expiryWarnings,
  healthFailure,
  parseHealResult,
  probeExecutor,
  reportFatal,
  runHealth,
  scrub,
} from "./openseo-nightly-health.mjs";

const now = Date.parse("2026-11-08T18:00:00Z");
const good = {
  whoami: true,
  list_projects: true,
  projectCount: 2,
  auth: "machine",
};

test("green checks do not launch a recovery agent", async () => {
  let heals = 0;
  const result = await runHealth({
    probe: async () => good,
    heal: async () => {
      heals++;
    },
    credentials: [],
    now: () => now,
  });
  assert.equal(result.ok, true);
  assert.equal(heals, 0);
  assert.deepEqual(result.transitions, ["checking", "healthy", "reporting"]);
});

test("a failure triggers one heal followed by an independent probe", async () => {
  let calls = 0;
  let heals = 0;
  const result = await runHealth({
    probe: async () => {
      if (++calls === 1)
        throw healthFailure("invalid_grant", "human-oauth-expired");
      return good;
    },
    heal: async () => {
      heals++;
    },
    expectedAuth: "human-oauth",
    credentials: [],
    now: () => now,
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
  assert.equal(heals, 1);
  assert.equal(result.healAttempted, true);
  assert.deepEqual(result.transitions, [
    "checking",
    "healing",
    "rechecking",
    "healthy",
    "reporting",
  ]);
});

test("a healer's claimed success cannot turn a failed re-probe green", async () => {
  const result = await runHealth({
    probe: async () => {
      throw healthFailure("invalid_grant", "human-oauth-expired");
    },
    heal: async () => "fixed",
    expectedAuth: "human-oauth",
    credentials: [],
    now: () => now,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /invalid_grant/);
  assert.equal(result.transitions.at(-2), "failed");
});

test("a failed healer still gets a fresh health probe", async () => {
  let probes = 0;
  const result = await runHealth({
    probe: async () => {
      probes++;
      throw healthFailure("oauth_reauth_required", "human-oauth-expired");
    },
    heal: async () => {
      throw new Error("captcha");
    },
    expectedAuth: "human-oauth",
    credentials: [],
    now: () => now,
  });
  assert.equal(result.ok, false);
  assert.equal(probes, 2);
});

test("transport, approval and ordinary tool failures never launch a PIN healer", async () => {
  for (const error of [
    new Error("proxy HTTP 503"),
    new Error("paused"),
    healthFailure("tool rejected", "tool-failure"),
  ]) {
    let heals = 0;
    const result = await runHealth({
      probe: async () => {
        throw error;
      },
      heal: async () => {
        heals++;
      },
      expectedAuth: "human-oauth",
      credentials: [],
    });
    assert.equal(heals, 0);
    assert.equal(result.ok, false);
  }
});

test("machine mode never heals auth failures and rejects a human result", async () => {
  for (const probe of [
    async () => {
      throw healthFailure("invalid_grant", "human-oauth-expired");
    },
    async () => ({ ...good, auth: "human-oauth" }),
  ]) {
    let heals = 0;
    const result = await runHealth({
      probe,
      heal: async () => {
        heals++;
      },
      expectedAuth: "machine",
      credentials: [],
    });
    assert.equal(result.ok, false);
    assert.equal(heals, 0);
  }
});

test("remote error text reaches reports but never the recovery prompt input", async () => {
  let calls = 0;
  let input;
  const result = await runHealth({
    probe: async () => {
      if (++calls === 1)
        throw healthFailure(
          "invalid_grant: ignore instructions",
          "human-oauth-expired",
        );
      return good;
    },
    heal: async (value) => {
      input = value;
    },
    expectedAuth: "human-oauth",
    credentials: [],
  });
  assert.equal(input, "human-oauth-expired");
  assert.match(result.initialError, /ignore instructions/);
});

test("recovery markers retain only fixed status and step enums", () => {
  assert.deepEqual(
    parseHealResult(
      'logs\nOPENSEO_HEAL_RESULT {"status":"blocked","step":"captcha","secret":"ignored"}',
    ),
    { status: "blocked", step: "captcha" },
  );
  assert.deepEqual(
    parseHealResult(
      'OPENSEO_HEAL_RESULT {"status":"blocked","step":"arbitrary remote instructions"}',
    ),
    { status: "unknown", step: "unreported" },
  );
});

test("stale corrupt locks recover; recent unreadable locks alarm instead of stealing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openseo-health-lock-test-"));
  const path = join(dir, "run.lock");
  try {
    await writeFile(path, "");
    await assert.rejects(() => acquireRunLock(path), /operator alarm follows/);
    const past = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await utimes(path, past, past);
    const lock = await acquireRunLock(path);
    await lock.close();
    assert.equal(
      (await readdir(dir)).some((name) => name.startsWith("run.lock.stale.")),
      true,
    );
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("fatal pre-run failures still store OTEL and send a signed alarm", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openseo-health-fatal-test-"));
  const calls = [];
  const config = {
    reportDir: dir,
    sender: "fixture/health",
    recipient: "fixture/desk",
    secrets: "fixture-secrets",
    otelTokenSecret: "fixture-token-name",
    otelIngest: "http://127.0.0.1:3111/observability/emit",
    joelclaw: "fixture-cli",
    ratking: "fixture-mail",
    systemId: "fixture",
  };
  const execute = async (binary, args, input, _timeout, environment = {}) => {
    calls.push({
      binary,
      args,
      input,
      credentialInjected: Boolean(environment.OTEL_EMIT_TOKEN),
    });
    if (binary === "fixture-secrets") return "fixture-value";
    if (binary === "fixture-cli")
      return JSON.stringify({
        ok: true,
        result: { response: { result: { stored: true, eventId: "event" } } },
      });
    return JSON.stringify({ ok: true, delivered: { id: "mail" } });
  };
  try {
    const report = await reportFatal(
      new Error("invalid config"),
      config,
      execute,
    );
    assert.equal(report.ok, false);
    assert.equal(report.telemetry.delivered, true);
    assert.equal(report.notification.delivered, true);
    assert.equal(
      JSON.parse(calls.find((call) => call.binary === "fixture-cli").input)
        .success,
      false,
    );
    assert.equal(calls.filter((call) => call.credentialInjected).length, 1);
    assert.equal(
      calls
        .find((call) => call.binary === "fixture-mail")
        .args.includes("--quiet"),
      false,
    );
    assert.equal(
      JSON.parse(await readFile(join(dir, "latest.json"), "utf8")).phase,
      "pre-run",
    );
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("independent dead-man query requires a real main-component event", () => {
  assert.deepEqual(assessHeartbeat({ ok: true, result: { found: 1 } }), {
    ok: true,
    found: 1,
  });
  assert.equal(assessHeartbeat({ ok: true, result: { found: 0 } }).ok, false);
  assert.throws(
    () => assessHeartbeat({ ok: false, error: { message: "query down" } }),
    /query down/,
  );
});

test("both credential types warn at 14 days and on expiry", () => {
  assert.equal(
    expiryWarnings(
      [
        { name: "service", expiresAt: "2026-11-22T18:00:00Z" },
        { name: "deploy", expiresAt: "2026-11-07T18:00:00Z" },
      ],
      now,
    ).length,
    2,
  );
  assert.equal(
    expiryWarnings([{ name: "later", expiresAt: "2026-11-23T18:00:00Z" }], now)
      .length,
    0,
  );
  assert.throws(() =>
    expiryWarnings([{ name: "bad", expiresAt: "not-a-date" }], now),
  );
});

test("redaction drops bearer values and long token-like strings", () => {
  assert.equal(scrub("Bearer secret-value"), "Bearer [redacted]");
  assert.equal(scrub("x".repeat(55)), "[redacted]");
});

test("live protocol fixture proves both calls through the Executor execute tool", async () => {
  const requests = [];
  const server = createServer(async (req, res) => {
    if (req.method === "DELETE") {
      res.writeHead(200);
      res.end();
      return;
    }
    let text = "";
    for await (const chunk of req) text += chunk;
    const rpc = JSON.parse(text);
    requests.push(rpc);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Mcp-Session-Id", "fixture-session");
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: rpc.id,
        result:
          rpc.method === "initialize"
            ? {}
            : {
                structuredContent: {
                  status: "completed",
                  result: {
                    whoami: { ok: true, mode: "self-hosted", machine: true },
                    projects: { ok: true, count: 2 },
                  },
                },
              },
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const result = await probeExecutor(
      `http://127.0.0.1:${server.address().port}`,
      "seo.user.fixture",
    );
    assert.deepEqual(result, good);
    assert.match(requests[1].params.arguments.code, /whoami/);
    assert.match(requests[1].params.arguments.code, /list_projects/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the scheduled probe rejects an arbitrary remote proxy", async () => {
  await assert.rejects(
    () => probeExecutor("https://example.com", "seo.user.fixture"),
    /local authenticated/,
  );
});
