import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { NativeRuntime, NativeWakeV1 } from "../src/adapters.js";
import { dispatchNativeHook } from "../src/hook-entry.js";
import {
  captureNativeRun,
  replayNativeRunCaptureOutboxes,
  shouldCaptureNativeRun,
} from "../src/raw-capture.js";

const roots: string[] = [];

const fixture = async (runtime: NativeRuntime, eventName: string) => {
  const home = await mkdtemp(path.join(tmpdir(), "flowing-raw-capture-"));
  roots.push(home);
  const authPath = path.join(home, ".joelclaw", "auth.json");
  const transcriptPath = path.join(home, "synthetic-session.jsonl");
  await mkdir(path.dirname(authPath), { recursive: true });
  await writeFile(
    authPath,
    JSON.stringify({ machine_id: "fixture-machine", token: "fixture-token", user_id: "fixture-user" }),
  );
  await writeFile(
    transcriptPath,
    `${JSON.stringify({ type: "message", message: { role: "assistant", content: "synthetic" } })}\n`,
  );
  const wake: NativeWakeV1 = {
    close: eventName.toLowerCase().includes("end"),
    eventId: "f".repeat(64),
    eventName,
    incarnationId: "fixture-incarnation",
    occurredAt: "2026-09-05T12:00:00.000Z",
    runtime,
    schemaVersion: 1,
    sessionId: "fixture-session",
    transcriptPath,
  };
  return { authPath, home, wake };
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("raw Run capture", () => {
  it.each([
    ["pi", "turn_end", "pi"],
    ["claude", "Stop", "claude-code"],
    ["codex", "Stop", "codex"],
  ] as const)("captures %s through /api/runs without a semantic event", async (runtime, eventName, expectedRuntime) => {
    const { authPath, home, wake } = await fixture(runtime, eventName);
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const result = await captureNativeRun(wake, {
      env: {
        HOME: home,
        JOELCLAW_AUTH_PATH: authPath,
        JOELCLAW_SESSION_CAPTURE_URL: "https://capture.invalid",
      },
      fetch: async (input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push({ url: String(input), body });
        return Response.json(
          { run_id: "accepted-run", status: "accepted", to_offset: body.to_offset },
          { status: 202 },
        );
      },
      home,
      now: () => Date.parse("2026-09-05T12:00:01.000Z"),
      runId: () => "fixture-run",
      verifySource: async () => undefined,
    });

    expect(result).toMatchObject({ status: "accepted", runId: "accepted-run" });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: "https://capture.invalid/api/runs",
      body: {
        agent_runtime: expectedRuntime,
        run_id: "fixture-run",
        source_session_id: "fixture-session",
      },
    });
    const expectedSourceIdentity = `sha256:${createHash("sha256")
      .update(
        JSON.stringify([
          expectedRuntime,
          "fixture-machine",
          wake.sessionId,
          wake.transcriptPath,
        ]),
      )
      .digest("hex")}`;
    expect(requests[0]?.body.source_identity).toBe(expectedSourceIdentity);
    expect(JSON.stringify(requests[0]?.body)).not.toContain("observation.submitted");
    expect(JSON.stringify(requests[0]?.body)).not.toContain("semantic");
  });

  it.each([
    ["cursor", "stop"],
    ["grok", "Stop"],
  ] as const)("leaves the %s flowing hook wake-only because its native sweep owns raw capture", async (runtime, eventName) => {
    const { authPath, home, wake } = await fixture(runtime, eventName);
    let requests = 0;
    const result = await captureNativeRun(wake, {
      env: {
        HOME: home,
        JOELCLAW_AUTH_PATH: authPath,
        JOELCLAW_SESSION_CAPTURE_URL: "https://capture.invalid",
      },
      fetch: async () => {
        requests += 1;
        return Response.json({}, { status: 202 });
      },
      home,
    });
    expect(result).toEqual({ status: "noop", reason: "event" });
    expect(requests).toBe(0);
  });

  it("retains a namespaced outbox and writes bounded structured failure telemetry", async () => {
    const { authPath, home, wake } = await fixture("claude", "Stop");
    const result = await captureNativeRun(wake, {
      env: {
        HOME: home,
        JOELCLAW_AUTH_PATH: authPath,
        JOELCLAW_SESSION_CAPTURE_URL: "https://capture.invalid",
      },
      fetch: async () => {
        throw new Error("synthetic network failure with private detail");
      },
      home,
      runId: () => "fixture-run",
      verifySource: async () => undefined,
    });

    expect(result).toEqual({ status: "degraded", code: "network-failed" });
    const root = path.join(home, ".joelclaw", "capture", "fixture-machine", "claude-code");
    expect(await readdir(path.join(root, "outbox"))).toHaveLength(1);
    const log = await readFile(path.join(root, "capture.log"), "utf8");
    const event = JSON.parse(log.trim()) as Record<string, unknown>;
    expect(event).toMatchObject({
      action: "memory.run.capture.failed",
      component: "native-run-capture",
      error: "network-failed",
      source: "memory",
      success: false,
    });
    expect(log).not.toContain("private detail");
    await expect(readdir(path.join(home, ".joelclaw", "outbox"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("replays only the namespaced adapter outbox and drains an accepted prefix suffix", async () => {
    const { authPath, home, wake } = await fixture("claude", "Stop");
    const second = `${JSON.stringify({ type: "assistant", content: "second" })}\n`;
    await writeFile(wake.transcriptPath, `${await readFile(wake.transcriptPath, "utf8")}${second}`);
    const common = {
      env: {
        HOME: home,
        JOELCLAW_AUTH_PATH: authPath,
        JOELCLAW_SESSION_CAPTURE_URL: "https://capture.invalid",
      },
      home,
      runId: () => "fixture-run",
      verifySource: async () => undefined,
    };
    expect(
      await captureNativeRun(wake, {
        ...common,
        fetch: async () => {
          throw new Error("offline");
        },
      }),
    ).toEqual({ status: "degraded", code: "network-failed" });

    await unlink(wake.transcriptPath);
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const firstBytes = Buffer.byteLength(
      `${JSON.stringify({ type: "message", message: { role: "assistant", content: "synthetic" } })}\n`,
    );
    const receipt = await replayNativeRunCaptureOutboxes({
      ...common,
      fetch: async (input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push({ url: String(input), body });
        return requests.length === 1
          ? Response.json(
              {
                run_id: "canonical-prefix-run",
                status: "accepted_prefix",
                to_offset: firstBytes,
              },
              { status: 202 },
            )
          : Response.json(
              {
                run_id: "canonical-suffix-run",
                status: "accepted",
                to_offset: body.to_offset,
              },
              { status: 202 },
            );
      },
    });

    expect(receipt).toEqual({ accepted: 2, attempted: 1, failed: 0, invalid: 0, stale: 0 });
    expect(requests.map((request) => request.url)).toEqual([
      "https://capture.invalid/api/runs",
      "https://capture.invalid/api/runs",
    ]);
    expect(requests[1]?.body).toMatchObject({
      from_offset: firstBytes,
      jsonl: second,
      parent_run_id: "canonical-prefix-run",
    });
    const outboxDir = path.join(
      home,
      ".joelclaw",
      "capture",
      "fixture-machine",
      "claude-code",
      "outbox",
    );
    expect(await readdir(outboxDir)).toEqual([]);
  });

  it("persists an accepted-prefix suffix before removing the original outbox", async () => {
    const { authPath, home, wake } = await fixture("claude", "Stop");
    const first = await readFile(wake.transcriptPath, "utf8");
    const second = `${JSON.stringify({ type: "assistant", content: "tail" })}\n`;
    await writeFile(wake.transcriptPath, first + second);
    const result = await captureNativeRun(wake, {
      env: {
        HOME: home,
        JOELCLAW_AUTH_PATH: authPath,
        JOELCLAW_SESSION_CAPTURE_URL: "https://capture.invalid",
      },
      fetch: async () =>
        Response.json(
          {
            run_id: "prefix-run",
            status: "accepted_prefix",
            to_offset: Buffer.byteLength(first),
          },
          { status: 202 },
        ),
      home,
      runId: () => "suffix-run",
      verifySource: async () => undefined,
    });
    expect(result).toMatchObject({ status: "accepted", toOffset: Buffer.byteLength(first) });
    const outboxDir = path.join(
      home,
      ".joelclaw",
      "capture",
      "fixture-machine",
      "claude-code",
      "outbox",
    );
    const files = await readdir(outboxDir);
    expect(files).toHaveLength(1);
    const envelope = JSON.parse(await readFile(path.join(outboxDir, files[0]!), "utf8")) as {
      body: Record<string, unknown>;
    };
    expect(envelope.body).toMatchObject({
      run_id: "suffix-run",
      parent_run_id: "prefix-run",
      from_offset: Buffer.byteLength(first),
      jsonl: second,
    });
  });

  it("does not trust an offset or parent from state bound to another source", async () => {
    const { authPath, home, wake } = await fixture("claude", "Stop");
    const env = {
      HOME: home,
      JOELCLAW_AUTH_PATH: authPath,
      JOELCLAW_SESSION_CAPTURE_URL: "https://capture.invalid",
    };
    await captureNativeRun(wake, {
      env,
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json(
          { run_id: "first-run", status: "accepted", to_offset: body.to_offset },
          { status: 202 },
        );
      },
      home,
      runId: () => "first-run",
      verifySource: async () => undefined,
    });
    const stateDir = path.join(
      home,
      ".joelclaw",
      "capture",
      "fixture-machine",
      "claude-code",
      "state",
    );
    const [stateName] = await readdir(stateDir);
    const statePath = path.join(stateDir, stateName!);
    const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    await writeFile(statePath, JSON.stringify({ ...state, source_identity: `sha256:${"0".repeat(64)}` }));
    let posted: Record<string, unknown> | undefined;
    await captureNativeRun(wake, {
      env,
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        posted = body;
        return Response.json(
          { run_id: "second-run", status: "accepted", to_offset: body.to_offset },
          { status: 202 },
        );
      },
      home,
      runId: () => "second-run",
      verifySource: async () => undefined,
    });
    expect(posted?.from_offset).toBe(0);
    expect(posted).not.toHaveProperty("parent_run_id");
  });

  it("keeps concurrent sessions in independent state files", async () => {
    const { authPath, home, wake } = await fixture("claude", "Stop");
    const secondPath = path.join(home, "synthetic-session-b.jsonl");
    await writeFile(secondPath, `${JSON.stringify({ type: "assistant", content: "two" })}\n`);
    const secondWake = {
      ...wake,
      eventId: "e".repeat(64),
      sessionId: "fixture-session-b",
      transcriptPath: secondPath,
    };
    const requests: Record<string, unknown>[] = [];
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const fetchImpl = (async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);
      if (requests.length === 2) releaseBarrier();
      await barrier;
      return Response.json(
        { run_id: body.run_id, status: "accepted", to_offset: body.to_offset },
        { status: 202 },
      );
    }) as unknown as typeof fetch;
    const dependencies = {
      env: {
        HOME: home,
        JOELCLAW_AUTH_PATH: authPath,
        JOELCLAW_SESSION_CAPTURE_URL: "https://capture.invalid",
      },
      fetch: fetchImpl,
      home,
      verifySource: async () => undefined,
    };

    const results = await Promise.all([
      captureNativeRun(wake, dependencies),
      captureNativeRun(secondWake, dependencies),
    ]);
    expect(results.map((result) => result.status)).toEqual(["accepted", "accepted"]);
    const stateDir = path.join(
      home,
      ".joelclaw",
      "capture",
      "fixture-machine",
      "claude-code",
      "state",
    );
    expect(await readdir(stateDir)).toHaveLength(2);
  });

  it("rejects an untrusted source before reading or posting it", async () => {
    const { authPath, home, wake } = await fixture("claude", "Stop");
    let requests = 0;
    const result = await captureNativeRun(wake, {
      env: {
        HOME: home,
        JOELCLAW_AUTH_PATH: authPath,
        JOELCLAW_SESSION_CAPTURE_URL: "https://capture.invalid",
      },
      fetch: async () => {
        requests += 1;
        return Response.json({}, { status: 202 });
      },
      home,
      verifySource: async () => {
        throw new Error("invalid-source-root");
      },
    });
    expect(result).toEqual({ status: "degraded", code: "source-untrusted" });
    expect(requests).toBe(0);
  });

  it("keeps live state and outbox durable when a receipt uses a numeric string offset", async () => {
    const { authPath, home, wake } = await fixture("codex", "Stop");
    const env = {
      HOME: home,
      JOELCLAW_AUTH_PATH: authPath,
      JOELCLAW_SESSION_CAPTURE_URL: "https://capture.invalid",
    };
    const common = {
      env,
      home,
      verifySource: async () => undefined,
    };
    const first = await captureNativeRun(wake, {
      ...common,
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json(
          { run_id: "first-run", status: "accepted", to_offset: body.to_offset },
          { status: 202 },
        );
      },
      runId: () => "first-run",
    });
    expect(first.status).toBe("accepted");
    const stateDir = path.join(home, ".joelclaw", "capture", "fixture-machine", "codex", "state");
    const [stateName] = await readdir(stateDir);
    const statePath = path.join(stateDir, stateName!);
    const priorState = await readFile(statePath, "utf8");
    await writeFile(wake.transcriptPath, `${await readFile(wake.transcriptPath, "utf8")}tail\n`);

    const result = await captureNativeRun(wake, {
      ...common,
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json(
          { run_id: "second-run", status: "accepted", to_offset: String(body.to_offset) },
          { status: 202 },
        );
      },
      runId: () => "second-run",
    });

    expect(result).toEqual({ status: "degraded", code: "response-invalid" });
    expect(await readFile(statePath, "utf8")).toBe(priorState);
    expect(
      await readdir(path.join(home, ".joelclaw", "capture", "fixture-machine", "codex", "outbox")),
    ).toHaveLength(1);
  });

  it("keeps replay state and outbox durable when a receipt uses a numeric string offset", async () => {
    const { authPath, home, wake } = await fixture("codex", "Stop");
    const env = {
      HOME: home,
      JOELCLAW_AUTH_PATH: authPath,
      JOELCLAW_SESSION_CAPTURE_URL: "https://capture.invalid",
    };
    const common = {
      env,
      home,
      verifySource: async () => undefined,
    };
    await captureNativeRun(wake, {
      ...common,
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json(
          { run_id: "first-run", status: "accepted", to_offset: body.to_offset },
          { status: 202 },
        );
      },
      runId: () => "first-run",
    });
    const stateDir = path.join(home, ".joelclaw", "capture", "fixture-machine", "codex", "state");
    const [stateName] = await readdir(stateDir);
    const statePath = path.join(stateDir, stateName!);
    const priorState = await readFile(statePath, "utf8");
    await writeFile(wake.transcriptPath, `${await readFile(wake.transcriptPath, "utf8")}tail\n`);
    await captureNativeRun(wake, {
      ...common,
      fetch: async () => {
        throw new Error("offline");
      },
      runId: () => "second-run",
    });
    const outboxDir = path.join(
      home,
      ".joelclaw",
      "capture",
      "fixture-machine",
      "codex",
      "outbox",
    );
    expect(await readdir(outboxDir)).toHaveLength(1);

    const receipt = await replayNativeRunCaptureOutboxes({
      env,
      home,
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json(
          { run_id: "second-run", status: "accepted", to_offset: String(body.to_offset) },
          { status: 202 },
        );
      },
    });

    expect(receipt).toMatchObject({ accepted: 0, failed: 1 });
    expect(await readFile(statePath, "utf8")).toBe(priorState);
    expect(await readdir(outboxDir)).toHaveLength(1);
  });

  it.each([
    { name: "boolean", offset: (_from: number, _to: number): unknown => true },
    { name: "array", offset: (_from: number, to: number): unknown => [to] },
    { name: "null", offset: (_from: number, _to: number): unknown => null },
    { name: "fractional", offset: (_from: number, to: number): unknown => to - 0.5 },
    { name: "no progress", offset: (from: number, _to: number): unknown => from },
    { name: "past end", offset: (_from: number, to: number): unknown => to + 1 },
    {
      name: "unsafe integer",
      offset: (_from: number, _to: number): unknown => Number.MAX_SAFE_INTEGER + 1,
    },
  ])("rejects a $name accepted offset without removing the live outbox", async ({ offset }) => {
    const { authPath, home, wake } = await fixture("codex", "Stop");
    const result = await captureNativeRun(wake, {
      env: {
        HOME: home,
        JOELCLAW_AUTH_PATH: authPath,
        JOELCLAW_SESSION_CAPTURE_URL: "https://capture.invalid",
      },
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as {
          from_offset: number;
          to_offset: number;
        };
        return Response.json(
          {
            run_id: "fixture-run",
            status: "accepted",
            to_offset: offset(body.from_offset, body.to_offset),
          },
          { status: 202 },
        );
      },
      home,
      runId: () => "fixture-run",
      verifySource: async () => undefined,
    });
    expect(result).toEqual({ status: "degraded", code: "response-invalid" });
    expect(
      await readdir(path.join(home, ".joelclaw", "capture", "fixture-machine", "codex", "outbox")),
    ).toHaveLength(1);
  });

  it("rejects a success response without a bounded accepted offset", async () => {
    const { authPath, home, wake } = await fixture("codex", "Stop");
    const result = await captureNativeRun(wake, {
      env: {
        HOME: home,
        JOELCLAW_AUTH_PATH: authPath,
        JOELCLAW_SESSION_CAPTURE_URL: "https://capture.invalid",
      },
      fetch: async () => Response.json({ run_id: "fixture-run" }, { status: 202 }),
      home,
      runId: () => "fixture-run",
      verifySource: async () => undefined,
    });
    expect(result).toEqual({ status: "degraded", code: "response-invalid" });
  });

  it("captures only terminal or turn-boundary events", async () => {
    const { wake } = await fixture("claude", "PostToolBatch");
    expect(shouldCaptureNativeRun(wake)).toBe(false);
    expect(shouldCaptureNativeRun({ ...wake, eventName: "Stop" })).toBe(true);
    expect(shouldCaptureNativeRun({ ...wake, eventName: "Stop", exclusion: "inference-session" })).toBe(false);
  });
});

describe("one hook owner with independent outputs", () => {
  it("does not advertise the retired Pi raw extension as a second owner", async () => {
    const packageJson = JSON.parse(
      await readFile(
        path.resolve(import.meta.dirname, "../../pi-extensions/package.json"),
        "utf8",
      ),
    ) as { pi?: { extensions?: string[] } };
    expect(packageJson.pi?.extensions).not.toContain("./memory-capture/index.ts");
  });

  it("still submits the flowing wake when raw capture fails", async () => {
    const { wake } = await fixture("codex", "Stop");
    const calls: string[] = [];
    const result = await dispatchNativeHook(wake, {
      captureRun: async () => {
        calls.push("capture");
        throw new Error("capture failed");
      },
      submitWake: async () => {
        calls.push("wake");
      },
    });
    expect(calls.sort()).toEqual(["capture", "wake"]);
    expect(result).toEqual({ capture: "rejected", wake: "fulfilled" });
  });

  it("still captures the raw Run when flowing admission fails", async () => {
    const { wake } = await fixture("codex", "Stop");
    const calls: string[] = [];
    const result = await dispatchNativeHook(wake, {
      captureRun: async () => {
        calls.push("capture");
      },
      submitWake: async () => {
        calls.push("wake");
        throw new Error("wake failed");
      },
    });
    expect(calls.sort()).toEqual(["capture", "wake"]);
    expect(result).toEqual({ capture: "fulfilled", wake: "rejected" });
  });
});
