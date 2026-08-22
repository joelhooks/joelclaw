import {
  appendFile,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  readlink,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { AdmissionCommandV1 } from "@joelclaw-memory/domain";

import flowingMemoryPiExtension from "../src/pi-extension.js";
import { runtimeProcessIsIdle } from "../src/idle-probe.js";
import {
  appendNativeWake,
  buildTrustedAdmissionV1,
  decodeGrokEvent,
  decodeNativeEvent,
  doctorHookFragment,
  doctorPiHook,
  drainNativeWakeSpool,
  FLOWING_MEMORY_INTERNAL_MARKER_V1,
  installHookFragment,
  installHookFragments,
  installPiHook,
  inspectNativeCollector,
  runtimeHookEvents,
  scanNativeSources,
  startNativeCollectorService,
  submitNativeWake,
  uninstallHookFragment,
  uninstallHookFragments,
  uninstallPiHook,
  verifyNativeSource,
  makeTrustedNativeAdmissionPort,
} from "../src/index.js";

const wakeInput = (runtime: "claude" | "codex" | "cursor" | "pi", transcriptPath: string) => {
  switch (runtime) {
    case "pi":
      return { event_name: "turn_end", session_id: "session-pi", transcript_path: transcriptPath };
    case "claude":
      return {
        hook_event_name: "Stop",
        session_id: "session-claude",
        transcript_path: transcriptPath,
      };
    case "codex":
      return {
        event_name: "agent-turn-complete",
        thread_id: "session-codex",
        transcript_path: transcriptPath,
      };
    case "cursor":
      return {
        hook_event_name: "sessionEnd",
        conversation_id: "session-cursor",
        transcript_path: transcriptPath,
      };
  }
};

describe("native adapter pack", () => {
  it("rejects an active runtime in the process-idle fixture", () => {
    const active = "123 /usr/local/bin/pi --session live\n";
    const own = "456 /usr/local/bin/flowing-memory-host collector\n";
    expect(runtimeProcessIsIdle("pi", active, 999)).toBe(false);
    expect(runtimeProcessIsIdle("pi", own, 999)).toBe(true);
  });
  it.each(["pi", "claude", "codex", "cursor"] as const)(
    "decodes one strict %s event",
    (runtime) => {
      const result = decodeNativeEvent(runtime, wakeInput(runtime, "/tmp/native-session.jsonl"));
      expect(result).toMatchObject({ _tag: "Accepted", wake: { runtime } });
    },
  );

  it("maps Pi session_start and registers the complete lifecycle map", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fm-pi-extension-"));
    const spoolPath = path.join(root, "wakes.jsonl");
    const previousSpool = process.env.JOELCLAW_FLOWING_MEMORY_WAKE_SPOOL;
    process.env.JOELCLAW_FLOWING_MEMORY_WAKE_SPOOL = spoolPath;
    const handlers = new Map<string, (event: unknown, context: unknown) => void | Promise<void>>();
    try {
      flowingMemoryPiExtension({
        on: (event, handler) => {
          handlers.set(
            event,
            handler as (event: unknown, context: unknown) => void | Promise<void>,
          );
        },
      });
      expect([...handlers.keys()]).toEqual(["session_start", "turn_end", "session_shutdown"]);
      const context = {
        sessionManager: {
          getSessionFile: () => path.join(root, "session.jsonl"),
          getSessionId: () => "pi-extension-session",
        },
      };
      await handlers.get("session_start")?.({}, context);
      const lines = (await readFile(spoolPath, "utf8")).trim().split("\n");
      expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
        eventName: "session_start",
        runtime: "pi",
      });
    } finally {
      if (previousSpool === undefined) delete process.env.JOELCLAW_FLOWING_MEMORY_WAKE_SPOOL;
      else process.env.JOELCLAW_FLOWING_MEMORY_WAKE_SPOOL = previousSpool;
    }
  });

  it("excludes the entire trusted inference session", () => {
    expect(
      decodeNativeEvent("pi", {
        ...wakeInput("pi", "/tmp/native-session.jsonl"),
        internal_marker: FLOWING_MEMORY_INTERNAL_MARKER_V1,
      }),
    ).toEqual({ _tag: "Skipped", reason: "inference-session" });
  });

  it("rejects camelCase aliases in non-Pi decoders", () => {
    expect(
      decodeNativeEvent("codex", {
        eventName: "agent-turn-complete",
        thread_id: "session-codex",
        transcript_path: "/tmp/native-session.jsonl",
      }),
    ).toEqual({ _tag: "Rejected", code: "invalid-event" });
  });

  it("resolves exactly one Grok updates.jsonl", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fm-grok-"));
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, "nested", "updates.jsonl"), "{}\n");
    const accepted = await decodeGrokEvent({
      conversation_id: "grok-session",
      event_name: "session_end",
      session_dir: root,
    });
    expect(accepted).toMatchObject({
      _tag: "Accepted",
      wake: { close: true, runtime: "grok" },
    });
    await writeFile(path.join(root, "updates.jsonl"), "{}\n");
    expect(
      decodeGrokEvent({
        conversation_id: "grok-session",
        event_name: "session_end",
        session_dir: root,
      }),
    ).toMatchObject({ _tag: "Accepted", wake: { close: true, runtime: "grok" } });
  });

  it("resolves the real Grok camelCase envelope from cwd and sessionId", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fm-grok-home-"));
    const cwd = path.join(root, "workspace");
    const sessionId = "grok-camel-session";
    const sessionDirectory = path.join(
      root,
      "sessions",
      encodeURIComponent(path.resolve(cwd)),
      sessionId,
    );
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(path.join(sessionDirectory, "summary.json"), JSON.stringify({ sessionId }));
    await writeFile(path.join(sessionDirectory, "updates.jsonl"), "{}\n");
    const previousHome = process.env.GROK_HOME;
    process.env.GROK_HOME = root;
    try {
      const decoded = decodeGrokEvent({
        cwd,
        hookEventName: "stop",
        sessionId,
      });
      expect(decoded).toMatchObject({
        _tag: "Accepted",
        wake: {
          runtime: "grok",
          sessionId,
          transcriptPath: path.join(sessionDirectory, "updates.jsonl"),
        },
      });
      if (decoded._tag !== "Accepted") throw new Error("expected Grok wake");
      await expect(verifyNativeSource(decoded.wake)).resolves.toBeUndefined();
    } finally {
      if (previousHome === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = previousHome;
    }
  });
});

describe("trusted native admission", () => {
  it("decodes native JSONL, redacts a secret, and builds one acceptance-bound Run", () => {
    const occurredAt = new Date().toISOString();
    const transcriptPath = "/tmp/trusted-native-session.jsonl";
    const line = `${JSON.stringify({
      message: {
        content: "Use token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB for the canary.",
        role: "user",
      },
      timestamp: occurredAt,
      type: "message",
    })}\n`;
    const decoded = decodeNativeEvent("pi", {
      event_name: "turn_end",
      occurred_at: occurredAt,
      session_id: "trusted-native-session",
      transcript_path: transcriptPath,
    });
    if (decoded._tag !== "Accepted") throw new Error("expected wake");
    const bytes = new TextEncoder().encode(line);
    const built = buildTrustedAdmissionV1(
      {
        fromByte: 0,
        prefixBytes: bytes,
        segmentBytes: bytes,
        toByteExclusive: bytes.byteLength,
        wake: decoded.wake,
      },
      {
        adapterInstanceIdHash: "a".repeat(64),
        canonicalRepository: "github.com/joelhooks/joelclaw-memory",
        principalIdHash: "b".repeat(64),
        privacy: "private",
        project: "joelclaw-memory",
        repositoryHost: "github.com",
        repositoryName: "joelclaw-memory",
        repositoryOwner: "joelhooks",
        workstream: "prototype",
      },
    );
    expect(built.command._tag).toBe("accept");
    expect(built.acceptedRun?.turns[0]?.text).toContain("[REDACTED]");
    expect(built.acceptedRun?.turns[0]?.text).not.toContain("ghp_");
  });

  it("decodes Grok ACP message chunks without admitting thought chunks", () => {
    const timestamp = Date.now() - 1_000;
    const lines = [
      {
        method: "session/update",
        params: {
          update: {
            content: { text: "Grok user marker", type: "text" },
            sessionUpdate: "user_message_chunk",
          },
        },
        timestamp,
      },
      {
        method: "session/update",
        params: {
          update: {
            content: { text: "private model thought", type: "text" },
            sessionUpdate: "agent_thought_chunk",
          },
        },
        timestamp: timestamp + 1,
      },
      {
        method: "session/update",
        params: {
          update: {
            content: { text: "Grok assistant marker", type: "text" },
            sessionUpdate: "agent_message_chunk",
          },
        },
        timestamp: timestamp + 2,
      },
    ];
    const segment = new TextEncoder().encode(
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    );
    const decoded = decodeGrokEvent({
      cwd: "/tmp/grok-acp-workspace",
      hookEventName: "stop",
      sessionId: "grok-acp-session",
    });
    if (decoded._tag !== "Accepted") throw new Error("expected Grok wake");
    const built = buildTrustedAdmissionV1(
      {
        fromByte: 0,
        prefixBytes: segment,
        segmentBytes: segment,
        toByteExclusive: segment.byteLength,
        wake: decoded.wake,
      },
      {
        adapterInstanceIdHash: "a".repeat(64),
        canonicalRepository: "github.com/joelhooks/joelclaw-memory",
        principalIdHash: "b".repeat(64),
        privacy: "private",
        project: "joelclaw-memory",
        repositoryHost: "github.com",
        repositoryName: "joelclaw-memory",
        repositoryOwner: "joelhooks",
        workstream: "prototype",
      },
    );
    expect(built.command._tag).toBe("accept");
    if (built.acceptedRun === undefined) throw new Error("expected Grok Run");
    expect(built.acceptedRun.turns.map((turn) => [turn.role, turn.text])).toEqual([
      ["user", "Grok user marker"],
      ["assistant", "Grok assistant marker"],
    ]);
    expect(built.acceptedRun.turns[0]?.occurredAt?.epochMilliseconds).toBe(timestamp);
  });

  it("decodes Codex chat messages without admitting bootstrap context", () => {
    const timestamp = "2026-08-22T16:00:00.000Z";
    const lines = [
      {
        payload: {
          content: [{ text: "developer context", type: "input_text" }],
          role: "developer",
          type: "message",
        },
        timestamp,
        type: "response_item",
      },
      {
        payload: {
          content: [
            { text: "system graft", type: "input_text" },
            { text: "x".repeat(16_001), type: "input_text" },
            { text: "bootstrap", type: "input_text" },
          ],
          role: "user",
          type: "message",
        },
        timestamp,
        type: "response_item",
      },
      {
        payload: {
          content: [{ text: "Codex user marker", type: "input_text" }],
          role: "user",
          type: "message",
        },
        timestamp,
        type: "response_item",
      },
      {
        payload: {
          content: [{ text: "Codex assistant marker", type: "output_text" }],
          role: "assistant",
          type: "message",
        },
        timestamp,
        type: "response_item",
      },
    ];
    const segment = new TextEncoder().encode(
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    );
    const decoded = decodeNativeEvent("codex", {
      hook_event_name: "Stop",
      session_id: "codex-rollout-session",
      transcript_path: "/tmp/codex-rollout.jsonl",
    });
    if (decoded._tag !== "Accepted") throw new Error("expected Codex wake");
    const built = buildTrustedAdmissionV1(
      {
        fromByte: 0,
        prefixBytes: segment,
        segmentBytes: segment,
        toByteExclusive: segment.byteLength,
        wake: decoded.wake,
      },
      {
        adapterInstanceIdHash: "a".repeat(64),
        canonicalRepository: "github.com/joelhooks/joelclaw-memory",
        principalIdHash: "b".repeat(64),
        privacy: "private",
        project: "joelclaw-memory",
        repositoryHost: "github.com",
        repositoryName: "joelclaw-memory",
        repositoryOwner: "joelhooks",
        workstream: "prototype",
      },
    );
    if (built.acceptedRun === undefined) throw new Error("expected Codex Run");
    expect(built.acceptedRun.turns.map((turn) => [turn.role, turn.text])).toEqual([
      ["user", "Codex user marker"],
      ["assistant", "Codex assistant marker"],
    ]);
  });

  it("decodes Cursor string message records and preserves prior transcript hash", () => {
    const occurredAt = new Date().toISOString();
    const firstLine = `${JSON.stringify({ message: "Cursor first turn", role: "user" })}\n`;
    const secondLine = `${JSON.stringify({ message: "Cursor second turn", role: "assistant" })}\n`;
    const first = decodeNativeEvent("cursor", {
      hook_event_name: "afterAgentResponse",
      occurred_at: occurredAt,
      conversation_id: "cursor-string-session",
      transcript_path: "/tmp/cursor-string.jsonl",
    });
    if (first._tag !== "Accepted") throw new Error("expected Cursor wake");
    const config = {
      adapterInstanceIdHash: "a".repeat(64),
      canonicalRepository: "github.com/joelhooks/joelclaw-memory",
      principalIdHash: "b".repeat(64),
      privacy: "private" as const,
      project: "joelclaw-memory",
      repositoryHost: "github.com",
      repositoryName: "joelclaw-memory",
      repositoryOwner: "joelhooks",
      workstream: "prototype",
    };
    const firstBytes = new TextEncoder().encode(firstLine);
    const firstBuilt = buildTrustedAdmissionV1(
      {
        fromByte: 0,
        prefixBytes: firstBytes,
        segmentBytes: firstBytes,
        toByteExclusive: firstBytes.byteLength,
        wake: first.wake,
      },
      config,
    );
    if (firstBuilt.acceptedRun === undefined) throw new Error("expected first Run");
    const secondBytes = new TextEncoder().encode(firstLine + secondLine);
    const resumed = decodeNativeEvent("cursor", {
      hook_event_name: "afterAgentResponse",
      occurred_at: new Date(Date.now() + 1).toISOString(),
      conversation_id: "cursor-string-session",
      transcript_path: "/tmp/cursor-string.jsonl",
      incarnation_id: first.wake.incarnationId,
    });
    if (resumed._tag !== "Accepted") throw new Error("expected resumed Cursor wake");
    const secondBuilt = buildTrustedAdmissionV1(
      {
        fromByte: firstBytes.byteLength,
        prefixBytes: secondBytes,
        priorTurnCount: 1,
        previousTranscriptHash: firstBuilt.acceptedRun.transcriptHash,
        segmentBytes: secondBytes.subarray(firstBytes.byteLength),
        toByteExclusive: secondBytes.byteLength,
        wake: resumed.wake,
      },
      config,
    );
    expect(secondBuilt.acceptedRun?.turns[0]?.text).toBe("Cursor second turn");
    expect(secondBuilt.acceptedRun?.fromTurn).toBe(1);
    expect(secondBuilt.acceptedRun?.previousTranscriptHash).toBe(
      firstBuilt.acceptedRun.transcriptHash,
    );
  });

  it("uses local turn coordinates for a resumed incarnation through trusted admission", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fm-admission-resume-"));
    const config = {
      adapterInstanceIdHash: "a".repeat(64),
      canonicalRepository: "github.com/joelhooks/joelclaw-memory",
      principalIdHash: "b".repeat(64),
      privacy: "private" as const,
      project: "joelclaw-memory",
      repositoryHost: "github.com",
      repositoryName: "joelclaw-memory",
      repositoryOwner: "joelhooks",
      workstream: "prototype",
    };
    const firstLine = `${JSON.stringify({ message: { content: "prior", role: "user" } })}\n`;
    const secondLine = `${JSON.stringify({ message: { content: "resumed", role: "assistant" } })}\n`;
    const first = decodeNativeEvent("pi", {
      event_name: "turn_end",
      occurred_at: new Date().toISOString(),
      session_id: "trusted-resume-session",
      transcript_path: "/tmp/trusted-resume.jsonl",
      incarnation_id: "incarnation-one",
    });
    const resumed = decodeNativeEvent("pi", {
      event_name: "turn_end",
      occurred_at: new Date(Date.now() + 1).toISOString(),
      session_id: "trusted-resume-session",
      transcript_path: "/tmp/trusted-resume.jsonl",
      incarnation_id: "incarnation-two",
    });
    if (first._tag !== "Accepted" || resumed._tag !== "Accepted") {
      throw new Error("expected trusted resume wakes");
    }
    const commands: AdmissionCommandV1[] = [];
    const port = makeTrustedNativeAdmissionPort({
      config,
      evidenceDirectory: root,
      ledger: {
        admit: async (command) => {
          commands.push(command as AdmissionCommandV1);
          return {
            captureEventId: first.wake.eventId,
            commandFingerprint: "c".repeat(64),
            disposition: "admitted",
            invocationId: "d".repeat(64),
            schemaVersion: 1,
            sourceStreamId: "e".repeat(64),
            windowSeq: commands.length,
          } as never;
        },
      },
    });
    const firstBytes = new TextEncoder().encode(firstLine);
    await port.admit({
      fromByte: 0,
      prefixBytes: firstBytes,
      segmentBytes: firstBytes,
      toByteExclusive: firstBytes.byteLength,
      wake: first.wake,
    });
    const resumedBytes = new TextEncoder().encode(secondLine);
    await port.admit({
      fromByte: 0,
      prefixBytes: resumedBytes,
      priorTurnCount: 0,
      segmentBytes: resumedBytes,
      toByteExclusive: resumedBytes.byteLength,
      wake: resumed.wake,
    });
    const second = commands[1];
    if (second?._tag !== "accept") throw new Error("expected resumed accept command");
    expect(second.acceptance.fromTurn).toBe(0);
    expect(second.acceptance.toTurn).toBe(0);
    expect(second.acceptance.previousTranscriptHash).toBeUndefined();
  });

  it("retries identical accepted-run bytes after a ledger failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fm-admission-retry-"));
    const occurredAt = new Date().toISOString();
    const line = `${JSON.stringify({ message: { content: "retry me", role: "user" } })}\n`;
    const decoded = decodeNativeEvent("pi", {
      event_name: "turn_end",
      occurred_at: occurredAt,
      session_id: "retry-session",
      transcript_path: "/tmp/retry-session.jsonl",
    });
    if (decoded._tag !== "Accepted") throw new Error("expected wake");
    let calls = 0;
    const commands: unknown[] = [];
    const port = makeTrustedNativeAdmissionPort({
      config: {
        adapterInstanceIdHash: "a".repeat(64),
        canonicalRepository: "github.com/joelhooks/joelclaw-memory",
        principalIdHash: "b".repeat(64),
        privacy: "private",
        project: "joelclaw-memory",
        repositoryHost: "github.com",
        repositoryName: "joelclaw-memory",
        repositoryOwner: "joelhooks",
        workstream: "prototype",
      },
      evidenceDirectory: root,
      ledger: {
        admit: async (command) => {
          commands.push(command);
          calls += 1;
          if (calls === 1) throw new Error("synthetic-ledger-failure");
          return {
            captureEventId: decoded.wake.eventId,
            commandFingerprint: "a".repeat(64),
            disposition: "admitted",
            invocationId: "b".repeat(64),
            schemaVersion: 1,
            sourceStreamId: "c".repeat(64),
            windowSeq: 1,
          } as never;
        },
      },
    });
    const bytes = new TextEncoder().encode(line);
    const admissionInput = {
      fromByte: 0,
      prefixBytes: bytes,
      segmentBytes: bytes,
      toByteExclusive: bytes.byteLength,
      wake: decoded.wake,
    };
    await expect(port.admit(admissionInput)).rejects.toThrow("synthetic-ledger-failure");
    await expect(port.admit(admissionInput)).resolves.toMatchObject({ disposition: "admitted" });
    expect(commands[0]).toEqual(commands[1]);
    const acceptedFiles = await readdir(root);
    expect(acceptedFiles.some((name) => name.endsWith(".accepted-run-v1.json"))).toBe(true);
  });
});

describe("common collector", () => {
  it("spools locally and admits one suffix without network work in the hook", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fm-collector-"));
    const transcriptPath = path.join(root, "session.jsonl");
    const spoolPath = path.join(root, "wake.jsonl");
    await writeFile(transcriptPath, '{"type":"message"}\n');
    const decoded = decodeNativeEvent("pi", wakeInput("pi", transcriptPath));
    if (decoded._tag !== "Accepted") throw new Error("expected wake");
    await appendNativeWake(spoolPath, decoded.wake);
    const admitted: number[] = [];
    const receipt = await drainNativeWakeSpool({
      admission: {
        admit: async (input) => {
          admitted.push(input.segmentBytes.byteLength);
          return { disposition: "admitted" };
        },
      },
      lockPath: path.join(root, "collector.lock"),
      spoolPath,
      statePath: path.join(root, "state.json"),
    });
    expect(receipt).toMatchObject({ admitted: 1, processed: 1 });
    expect(admitted).toEqual([19]);
    expect(await readFile(path.join(root, "state.json"), "utf8")).not.toContain("message");
  });
  it("scans a changed active source into a recoverable wake", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fm-active-source-scan-"));
    const source = path.join(root, "pi-session.jsonl");
    await writeFile(source, '{"role":"user","message":"scan"}\n');
    const previous = process.env.JOELCLAW_FLOWING_MEMORY_PI_SOURCE_ROOT;
    process.env.JOELCLAW_FLOWING_MEMORY_PI_SOURCE_ROOT = root;
    try {
      const wakes = await scanNativeSources({ activeWindowMs: 60_000 });
      expect(wakes).toContainEqual(
        expect.objectContaining({
          eventName: "active_source_scan",
          runtime: "pi",
          transcriptPath: source,
        }),
      );
    } finally {
      if (previous === undefined) delete process.env.JOELCLAW_FLOWING_MEMORY_PI_SOURCE_ROOT;
      else process.env.JOELCLAW_FLOWING_MEMORY_PI_SOURCE_ROOT = previous;
    }
  });

  it("runs one wake through the collector socket service", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fm-collector-service-"));
    const transcriptPath = path.join(root, "session.jsonl");
    const wake = decodeNativeEvent("pi", wakeInput("pi", transcriptPath));
    if (wake._tag !== "Accepted") throw new Error("expected wake");
    await writeFile(transcriptPath, '{"role":"user","message":"service"}\n');
    const admitted: string[] = [];
    const service = await startNativeCollectorService({
      activeSourceScan: async () => [],
      admission: {
        admit: async (input) => {
          admitted.push(input.immutableStreamPath ?? "missing-stream");
          return { disposition: "admitted" };
        },
      },
      scanIntervalMs: 20,
      socketPath: path.join(root, "collector.sock"),
      spoolPath: path.join(root, "wake.jsonl"),
      statePath: path.join(root, "state.json"),
      streamRoot: path.join(root, "streams"),
    });
    await expect(
      startNativeCollectorService({
        activeSourceScan: async () => [],
        admission: { admit: async () => ({ disposition: "admitted" }) },
        scanIntervalMs: 20,
        socketPath: path.join(root, "collector.sock"),
        spoolPath: path.join(root, "wake.jsonl"),
        statePath: path.join(root, "state.json"),
        streamRoot: path.join(root, "streams"),
      }),
    ).rejects.toThrow("collector-already-running");
    await submitNativeWake({
      socketPath: path.join(root, "collector.sock"),
      spoolPath: path.join(root, "wake.jsonl"),
      wake: wake.wake,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await service.stop();
    expect(admitted).toHaveLength(1);
    expect(await readFile(admitted[0] ?? "", "utf8")).toContain("service");
  });

  it("serializes concurrent socket drains without dropping either wake", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fm-collector-service-queue-"));
    const socketPath = path.join(root, "collector.sock");
    const spoolPath = path.join(root, "wake.jsonl");
    const sources = [path.join(root, "session-a.jsonl"), path.join(root, "session-b.jsonl")];
    await Promise.all(
      sources.map((source, index) =>
        writeFile(source, `${JSON.stringify({ message: `service-${index}`, role: "user" })}\n`),
      ),
    );
    const wakes = sources.map((source, index) =>
      decodeNativeEvent("pi", {
        event_name: "turn_end",
        session_id: `service-session-${index}`,
        transcript_path: source,
      }),
    );
    const acceptedWakes = wakes.map((wake) => {
      if (wake._tag !== "Accepted") throw new Error("expected wake");
      return wake.wake;
    });
    let admissions = 0;
    const service = await startNativeCollectorService({
      activeSourceScan: async () => [],
      admission: {
        admit: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          admissions += 1;
          return { disposition: "admitted" };
        },
      },
      scanIntervalMs: 60_000,
      socketPath,
      spoolPath,
      statePath: path.join(root, "state.json"),
      streamRoot: path.join(root, "streams"),
    });
    await Promise.all(
      acceptedWakes.map((wake) => submitNativeWake({ socketPath, spoolPath, wake })),
    );
    await service.stop();
    expect(admissions).toBe(2);
    await expect(readFile(`${spoolPath}.quarantine.jsonl`, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("recovers a lost wake from the active source scan", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fm-collector-scan-"));
    const transcriptPath = path.join(root, "session.jsonl");
    await writeFile(transcriptPath, '{"role":"user","message":"scan"}\n');
    const decoded = decodeNativeEvent("pi", wakeInput("pi", transcriptPath));
    if (decoded._tag !== "Accepted") throw new Error("expected scan wake");
    let scans = 0;
    let admissions = 0;
    const service = await startNativeCollectorService({
      activeSourceScan: async () => {
        scans += 1;
        return scans === 1 ? [decoded.wake] : [];
      },
      admission: {
        admit: async () => {
          admissions += 1;
          return { disposition: "admitted" };
        },
      },
      scanIntervalMs: 10,
      socketPath: path.join(root, "collector.sock"),
      spoolPath: path.join(root, "wake.jsonl"),
      statePath: path.join(root, "state.json"),
      streamRoot: path.join(root, "streams"),
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await service.stop();
    expect(scans).toBeGreaterThan(0);
    expect(admissions).toBe(1);
  });

  it("verifies Grok source root and summary identity in the collector boundary", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fm-grok-source-"));
    const sessions = path.join(root, "sessions");
    const session = path.join(sessions, "grok-source-session");
    await mkdir(session, { recursive: true });
    await writeFile(
      path.join(session, "summary.json"),
      JSON.stringify({ session_id: "grok-source-session" }),
    );
    const updates = path.join(session, "updates.jsonl");
    await writeFile(updates, "{}\n");
    const oldHome = process.env.GROK_HOME;
    process.env.GROK_HOME = root;
    try {
      const decoded = decodeGrokEvent({
        conversation_id: "grok-source-session",
        event_name: "stop",
        session_dir: session,
      });
      if (decoded._tag !== "Accepted") throw new Error("expected Grok wake");
      await expect(verifyNativeSource(decoded.wake)).resolves.toBeUndefined();
      await mkdir(path.join(session, "nested"));
      await writeFile(path.join(session, "nested", "updates.jsonl"), "{}\n");
      await expect(verifyNativeSource(decoded.wake)).rejects.toThrow(
        "grok-updates-identity-ambiguous",
      );
      await expect(
        verifyNativeSource({ ...decoded.wake, transcriptPath: path.join(root, "outside.jsonl") }),
      ).rejects.toThrow("invalid-source-root");
    } finally {
      if (oldHome === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = oldHome;
    }
  });
});

describe("collector byte boundaries", () => {
  it("prevents Luna inference-session re-entry after one marked event", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fm-luna-exclusion-"));
    const transcriptPath = path.join(root, "session.jsonl");
    const spoolPath = path.join(root, "wake.jsonl");
    await writeFile(transcriptPath, '{"role":"assistant","message":"internal"}\n');
    const marked = decodeNativeEvent(
      "pi",
      {
        event_name: "turn_end",
        internal_marker: FLOWING_MEMORY_INTERNAL_MARKER_V1,
        session_id: "luna-session",
        transcript_path: transcriptPath,
      },
      { captureInferenceSession: true },
    );
    const later = decodeNativeEvent("pi", {
      event_name: "turn_end",
      session_id: "luna-session",
      transcript_path: transcriptPath,
    });
    if (marked._tag !== "Accepted" || later._tag !== "Accepted") {
      throw new Error("expected exclusion and later wake");
    }
    await appendNativeWake(spoolPath, marked.wake);
    await appendNativeWake(spoolPath, later.wake);
    let admissions = 0;
    const receipt = await drainNativeWakeSpool({
      admission: {
        admit: async () => {
          admissions += 1;
          return { disposition: "admitted" };
        },
      },
      lockPath: path.join(root, "collector.lock"),
      spoolPath,
      statePath: path.join(root, "state.json"),
      streamRoot: path.join(root, "streams"),
    });
    expect(admissions).toBe(0);
    expect(receipt.excluded).toBe(1);
    expect(receipt.replayed).toBe(1);
    expect(JSON.parse(await readFile(path.join(root, "state.json"), "utf8"))).toMatchObject({
      excludedSessions: ["pi:luna-session"],
    });
  });

  it("does not advance through an incomplete JSONL record", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fm-collector-partial-"));
    const transcriptPath = path.join(root, "session.jsonl");
    const spoolPath = path.join(root, "wake.jsonl");
    await writeFile(transcriptPath, '{"type":"partial"');
    const decoded = decodeNativeEvent("pi", wakeInput("pi", transcriptPath));
    if (decoded._tag !== "Accepted") throw new Error("expected wake");
    await appendNativeWake(spoolPath, decoded.wake);
    const admitted: number[] = [];
    const deferred = await drainNativeWakeSpool({
      admission: {
        admit: async (input) => {
          admitted.push(input.segmentBytes.byteLength);
          return { disposition: "admitted" };
        },
      },
      lockPath: path.join(root, "collector.lock"),
      spoolPath,
      statePath: path.join(root, "state.json"),
    });
    expect(deferred).toMatchObject({ deferred: 1, admitted: 0 });
    expect(admitted).toEqual([]);
    expect(await readFile(spoolPath, "utf8")).toContain(decoded.wake.eventId);
    await appendFile(transcriptPath, "}\n");
    const closeDecoded = decodeNativeEvent("pi", {
      ...wakeInput("pi", transcriptPath),
      event_name: "session_shutdown",
    });
    if (closeDecoded._tag !== "Accepted") throw new Error("expected close wake");
    await appendNativeWake(spoolPath, closeDecoded.wake);
    const finalized = await drainNativeWakeSpool({
      admission: {
        admit: async (input) => {
          admitted.push(input.segmentBytes.byteLength);
          return {
            acceptedToTurn: 0,
            disposition: input.wake.close ? ("finalized" as const) : ("admitted" as const),
          };
        },
      },
      lockPath: path.join(root, "collector.lock"),
      spoolPath,
      statePath: path.join(root, "state.json"),
    });
    expect(finalized).toMatchObject({ admitted: 2, processed: 2 });
    expect(admitted).toEqual([19, 0]);
    await expect(readFile(spoolPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resumes a vendor conversation from the prior incarnation cursor", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fm-collector-resume-"));
    const transcriptPath = path.join(root, "session.jsonl");
    const spoolPath = path.join(root, "wake.jsonl");
    const firstLine = '{"type":"first"}\n';
    const secondLine = '{"type":"second"}\n';
    const thirdLine = '{"type":"third"}\n';
    const fourthLine = '{"type":"fourth"}\n';
    await writeFile(transcriptPath, firstLine);
    const streamPaths: string[] = [];
    const first = decodeNativeEvent("pi", {
      ...wakeInput("pi", transcriptPath),
      event_name: "turn_end",
      incarnation_id: "incarnation-one",
    });
    if (first._tag !== "Accepted") throw new Error("expected first wake");
    await appendNativeWake(spoolPath, first.wake);
    const firstReceipt = await drainNativeWakeSpool({
      admission: {
        admit: async (input) => {
          streamPaths.push(input.immutableStreamPath ?? "missing-stream");
          expect(input.fromByte).toBe(0);
          expect(input.segmentBytes.byteLength).toBe(Buffer.byteLength(firstLine));
          return { acceptedToTurn: 0, disposition: "admitted" };
        },
      },
      lockPath: path.join(root, "collector.lock"),
      spoolPath,
      statePath: path.join(root, "state.json"),
    });
    expect(firstReceipt).toMatchObject({ admitted: 1 });
    const close = decodeNativeEvent("pi", {
      ...wakeInput("pi", transcriptPath),
      event_name: "session_shutdown",
      incarnation_id: "incarnation-one",
    });
    if (close._tag !== "Accepted") throw new Error("expected close wake");
    await appendNativeWake(spoolPath, close.wake);
    await drainNativeWakeSpool({
      admission: {
        admit: async (input) => {
          streamPaths.push(input.immutableStreamPath ?? "missing-stream");
          return { disposition: "finalized" };
        },
      },
      lockPath: path.join(root, "collector.lock"),
      spoolPath,
      statePath: path.join(root, "state.json"),
    });
    await appendFile(transcriptPath, secondLine);
    const resumed = decodeNativeEvent("pi", {
      ...wakeInput("pi", transcriptPath),
      event_name: "turn_end",
      incarnation_id: "incarnation-two",
      occurred_at: new Date(Date.now() + 1).toISOString(),
    });
    if (resumed._tag !== "Accepted") throw new Error("expected resumed wake");
    await appendNativeWake(spoolPath, resumed.wake);
    const suffixes: number[] = [];
    const resumedReceipt = await drainNativeWakeSpool({
      admission: {
        admit: async (input) => {
          streamPaths.push(input.immutableStreamPath ?? "missing-stream");
          suffixes.push(input.segmentBytes.byteLength);
          expect(input.fromByte).toBe(0);
          expect(input.segmentBytes.byteLength).toBe(Buffer.byteLength(secondLine));
          return { disposition: "admitted" };
        },
      },
      lockPath: path.join(root, "collector.lock"),
      spoolPath,
      statePath: path.join(root, "state.json"),
    });
    expect(resumedReceipt).toMatchObject({ admitted: 1 });
    expect(suffixes).toEqual([Buffer.byteLength(secondLine)]);
    expect(new Set(streamPaths).size).toBe(2);
    await appendFile(transcriptPath, thirdLine);
    const secondGrowth = decodeNativeEvent("pi", {
      ...wakeInput("pi", transcriptPath),
      event_name: "turn_end",
      incarnation_id: "incarnation-two",
    });
    if (secondGrowth._tag !== "Accepted") throw new Error("expected second growth wake");
    await appendNativeWake(spoolPath, secondGrowth.wake);
    const secondGrowthReceipt = await drainNativeWakeSpool({
      admission: {
        admit: async (input) => {
          expect(input.fromByte).toBe(Buffer.byteLength(secondLine));
          expect(input.segmentBytes.byteLength).toBe(Buffer.byteLength(thirdLine));
          return { acceptedToTurn: 1, disposition: "admitted" };
        },
      },
      lockPath: path.join(root, "collector.lock"),
      spoolPath,
      statePath: path.join(root, "state.json"),
    });
    expect(secondGrowthReceipt).toMatchObject({ admitted: 1, quarantined: 0 });
    await appendFile(transcriptPath, fourthLine);
    const secondClose = decodeNativeEvent("pi", {
      ...wakeInput("pi", transcriptPath),
      event_name: "session_shutdown",
      incarnation_id: "incarnation-two",
    });
    if (secondClose._tag !== "Accepted") throw new Error("expected second close wake");
    await appendNativeWake(spoolPath, secondClose.wake);
    const secondCloseReceipt = await drainNativeWakeSpool({
      admission: {
        admit: async (input) => {
          expect(input.fromByte).toBe(Buffer.byteLength(secondLine + thirdLine));
          expect(input.segmentBytes.byteLength).toBe(Buffer.byteLength(fourthLine));
          return { disposition: "finalized" };
        },
      },
      closeStableMs: 1,
      lockPath: path.join(root, "collector.lock"),
      spoolPath,
      statePath: path.join(root, "state.json"),
    });
    expect(secondCloseReceipt).toMatchObject({ admitted: 1, quarantined: 0 });
  });

  it("opens a legacy Grok resume incarnation before suffix bytes arrive", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fm-grok-live-resume-"));
    const transcriptPath = path.join(root, "updates.jsonl");
    const spoolPath = path.join(root, "wake.jsonl");
    const statePath = path.join(root, "state.json");
    const streamRoot = path.join(root, "streams");
    const firstLine = `${JSON.stringify({ message: "first Grok fact", role: "user" })}\n`;
    const secondLine = `${JSON.stringify({ message: "second Grok fact", role: "assistant" })}\n`;
    await writeFile(transcriptPath, firstLine);
    const decode = (eventName: "session_start" | "session_end" | "stop", timestamp: string) =>
      decodeGrokEvent({
        conversation_id: "grok-live-resume",
        event_name: eventName,
        session_dir: root,
        timestamp,
      });
    const admitted: Array<{
      fromByte: number;
      priorTurnCount: number | undefined;
      segmentBytes: number;
      streamPath: string | undefined;
    }> = [];
    const admission = {
      admit: async (input: {
        readonly fromByte: number;
        readonly priorTurnCount?: number;
        readonly segmentBytes: Uint8Array;
        readonly immutableStreamPath?: string;
        readonly wake: { readonly close: boolean };
      }) => {
        admitted.push({
          fromByte: input.fromByte,
          priorTurnCount: input.priorTurnCount,
          segmentBytes: input.segmentBytes.byteLength,
          streamPath: input.immutableStreamPath,
        });
        return {
          acceptedToTurn: 0,
          disposition: input.wake.close ? ("finalized" as const) : ("admitted" as const),
        };
      },
    };
    const firstStart = decode("session_start", "2026-08-22T15:00:00.000Z");
    if (firstStart._tag !== "Accepted") throw new Error("expected first Grok start");
    await appendNativeWake(spoolPath, firstStart.wake);
    await drainNativeWakeSpool({
      admission,
      lockPath: path.join(root, "lock"),
      spoolPath,
      statePath,
      streamRoot,
    });
    const firstClose = decode("session_end", "2026-08-22T15:00:01.000Z");
    if (firstClose._tag !== "Accepted") throw new Error("expected first Grok close");
    await appendNativeWake(spoolPath, firstClose.wake);
    await drainNativeWakeSpool({
      admission,
      closeStableMs: 1,
      lockPath: path.join(root, "lock"),
      spoolPath,
      statePath,
      streamRoot,
    });
    const secondStart = decode("session_start", "2026-08-22T15:00:02.000Z");
    if (secondStart._tag !== "Accepted") throw new Error("expected resumed Grok start");
    await appendNativeWake(spoolPath, secondStart.wake);
    await drainNativeWakeSpool({
      admission,
      lockPath: path.join(root, "lock"),
      spoolPath,
      statePath,
      streamRoot,
    });
    const afterStart = JSON.parse(await readFile(statePath, "utf8")) as {
      readonly streams: Record<string, { readonly closed?: boolean }>;
    };
    expect(Object.values(afterStart.streams)).toHaveLength(2);
    expect(Object.values(afterStart.streams).filter((entry) => entry.closed !== true)).toHaveLength(
      1,
    );
    const earlyClose = decode("session_end", "2026-08-22T15:00:03.000Z");
    if (earlyClose._tag !== "Accepted") throw new Error("expected early Grok close");
    await appendNativeWake(spoolPath, earlyClose.wake);
    const deferredClose = await drainNativeWakeSpool({
      admission,
      closeStableMs: 1,
      lockPath: path.join(root, "lock"),
      spoolPath,
      statePath,
      streamRoot,
    });
    expect(deferredClose.deferred).toBe(1);
    await appendFile(transcriptPath, secondLine);
    const secondStop = decode("stop", "2026-08-22T15:00:04.000Z");
    if (secondStop._tag !== "Accepted") throw new Error("expected resumed Grok stop");
    await appendNativeWake(spoolPath, secondStop.wake);
    await drainNativeWakeSpool({
      admission,
      lockPath: path.join(root, "lock"),
      spoolPath,
      statePath,
      streamRoot,
    });
    expect(admitted.at(-1)).toMatchObject({
      fromByte: 0,
      priorTurnCount: 0,
      segmentBytes: Buffer.byteLength(secondLine),
    });
    expect(new Set(admitted.map((item) => item.streamPath)).size).toBe(2);
  });

  it("starts a new Pi incarnation on session_start after an unclean prior run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fm-pi-incarnation-"));
    const transcriptPath = path.join(root, "session.jsonl");
    const spoolPath = path.join(root, "wake.jsonl");
    await writeFile(transcriptPath, '{"role":"user","message":"first"}\n');
    const start = decodeNativeEvent("pi", {
      event_name: "session_start",
      session_id: "unclean-pi-session",
      transcript_path: transcriptPath,
    });
    if (start._tag !== "Accepted") {
      throw new Error("expected initial Pi wake");
    }
    await appendNativeWake(spoolPath, start.wake);
    const streams: string[] = [];
    await drainNativeWakeSpool({
      admission: {
        admit: async (input) => {
          streams.push(input.immutableStreamPath ?? "missing");
          return { disposition: "admitted" };
        },
      },
      lockPath: path.join(root, "collector.lock"),
      spoolPath,
      statePath: path.join(root, "state.json"),
      streamRoot: path.join(root, "streams"),
    });
    await appendFile(transcriptPath, '{"role":"assistant","message":"second"}\n');
    const resumedStart = decodeNativeEvent("pi", {
      event_name: "session_start",
      session_id: "unclean-pi-session",
      transcript_path: transcriptPath,
    });
    if (resumedStart._tag !== "Accepted") {
      throw new Error("expected resumed Pi wake");
    }
    await appendNativeWake(spoolPath, resumedStart.wake);
    await drainNativeWakeSpool({
      admission: {
        admit: async (input) => {
          streams.push(input.immutableStreamPath ?? "missing");
          return { disposition: "admitted" };
        },
      },
      lockPath: path.join(root, "collector.lock"),
      spoolPath,
      statePath: path.join(root, "state.json"),
      streamRoot: path.join(root, "streams"),
    });
    expect(new Set(streams).size).toBe(2);
  });

  it("retains close work when incomplete bytes cannot settle before the cap", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fm-collector-close-cap-"));
    const transcriptPath = path.join(root, "session.jsonl");
    const spoolPath = path.join(root, "wake.jsonl");
    await writeFile(transcriptPath, '{"role":"user"');
    const decoded = decodeNativeEvent("pi", {
      ...wakeInput("pi", transcriptPath),
      event_name: "session_shutdown",
    });
    if (decoded._tag !== "Accepted") throw new Error("expected close wake");
    await appendNativeWake(spoolPath, decoded.wake);
    let clock = 0;
    const receipt = await drainNativeWakeSpool({
      admission: { admit: async () => ({ disposition: "finalized" }) },
      closeMaxMs: 5,
      closeStableMs: 2,
      lockPath: path.join(root, "collector.lock"),
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
      spoolPath,
      statePath: path.join(root, "state.json"),
    });
    expect(receipt).toMatchObject({ deferred: 1, quarantined: 0 });
    expect(await readFile(spoolPath, "utf8")).toContain(decoded.wake.eventId);
  });

  it("replays after admission succeeds before state persistence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fm-collector-replay-"));
    const transcriptPath = path.join(root, "session.jsonl");
    const spoolPath = path.join(root, "wake.jsonl");
    await writeFile(transcriptPath, "replay\n");
    const decoded = decodeNativeEvent("pi", wakeInput("pi", transcriptPath));
    if (decoded._tag !== "Accepted") throw new Error("expected wake");
    await appendNativeWake(spoolPath, decoded.wake);
    let persistCalls = 0;
    let admissionCalls = 0;
    const first = await drainNativeWakeSpool({
      admission: {
        admit: async () => {
          admissionCalls += 1;
          return { disposition: "admitted" };
        },
      },
      lockPath: path.join(root, "collector.lock"),
      persistState: async () => {
        persistCalls += 1;
        if (persistCalls === 1) throw new Error("synthetic-state-crash");
      },
      spoolPath,
      statePath: path.join(root, "state.json"),
      streamRoot: path.join(root, "streams"),
    });
    expect(first).toMatchObject({ deferred: 1, processed: 1 });
    const second = await drainNativeWakeSpool({
      admission: {
        admit: async () => {
          admissionCalls += 1;
          return { disposition: "replay" };
        },
      },
      lockPath: path.join(root, "collector.lock"),
      spoolPath,
      statePath: path.join(root, "state.json"),
      streamRoot: path.join(root, "streams"),
    });
    expect(admissionCalls).toBe(1);
    expect(JSON.parse(await readFile(path.join(root, "state.json"), "utf8"))).toMatchObject({
      schemaVersion: 1,
    });
  });

  it("appends valid vendor growth after an admission-state persistence cut", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fm-collector-growth-retry-"));
    const transcriptPath = path.join(root, "session.jsonl");
    const spoolPath = path.join(root, "wake.jsonl");
    const firstLine = '{"role":"user","message":"first"}\n';
    const secondLine = '{"role":"assistant","message":"growth"}\n';
    await writeFile(transcriptPath, firstLine);
    const decoded = decodeNativeEvent("pi", wakeInput("pi", transcriptPath));
    if (decoded._tag !== "Accepted") throw new Error("expected growth wake");
    await appendNativeWake(spoolPath, decoded.wake);
    await drainNativeWakeSpool({
      admission: { admit: async () => ({ disposition: "admitted" }) },
      lockPath: path.join(root, "collector.lock"),
      persistState: async () => {
        throw new Error("synthetic-state-cut");
      },
      spoolPath,
      statePath: path.join(root, "state.json"),
      streamRoot: path.join(root, "streams"),
    });
    await appendFile(transcriptPath, secondLine);
    let retryBytes = 0;
    const receipt = await drainNativeWakeSpool({
      admission: {
        admit: async (input) => {
          retryBytes = input.prefixBytes.byteLength;
          return { disposition: "replay" };
        },
      },
      lockPath: path.join(root, "collector.lock"),
      spoolPath,
      statePath: path.join(root, "state.json"),
      streamRoot: path.join(root, "streams"),
    });
    expect(receipt.quarantined).toBe(0);
    expect(receipt.replayed).toBe(1);
    expect(retryBytes).toBe(Buffer.byteLength(firstLine + secondLine));
    const streams = await readdir(path.join(root, "streams"));
    expect(streams).toHaveLength(1);
    expect(await readFile(path.join(root, "streams", streams[0] ?? ""), "utf8")).toBe(
      firstLine + secondLine,
    );
  });

  it("retries growth through the real trusted admission port without an identity conflict", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fm-collector-trusted-growth-"));
    const transcriptPath = path.join(root, "session.jsonl");
    const spoolPath = path.join(root, "wake.jsonl");
    const firstLine = '{"role":"user","message":"trusted-first"}\n';
    const secondLine = '{"role":"assistant","message":"trusted-growth"}\n';
    await writeFile(transcriptPath, firstLine);
    const decoded = decodeNativeEvent("pi", {
      event_name: "turn_end",
      occurred_at: "2026-08-22T00:00:00.000Z",
      session_id: "trusted-growth-session",
      transcript_path: transcriptPath,
    });
    if (decoded._tag !== "Accepted") throw new Error("expected trusted growth wake");
    const commands: AdmissionCommandV1[] = [];
    const port = makeTrustedNativeAdmissionPort({
      config: {
        adapterInstanceIdHash: "a".repeat(64),
        canonicalRepository: "github.com/joelhooks/joelclaw-memory",
        principalIdHash: "b".repeat(64),
        privacy: "private",
        project: "joelclaw-memory",
        repositoryHost: "github.com",
        repositoryName: "joelclaw-memory",
        repositoryOwner: "joelhooks",
        workstream: "prototype",
      },
      evidenceDirectory: path.join(root, "evidence"),
      ledger: {
        admit: async (command) => {
          commands.push(command as AdmissionCommandV1);
          return {
            captureEventId: decoded.wake.eventId,
            commandFingerprint: "c".repeat(64),
            disposition: "admitted",
            invocationId: "d".repeat(64),
            schemaVersion: 1,
            sourceStreamId: "e".repeat(64),
            windowSeq: commands.length,
          } as never;
        },
      },
    });
    await appendNativeWake(spoolPath, decoded.wake);
    await drainNativeWakeSpool({
      admission: port,
      lockPath: path.join(root, "collector.lock"),
      persistState: async () => {
        throw new Error("synthetic-state-cut");
      },
      spoolPath,
      statePath: path.join(root, "state.json"),
      streamRoot: path.join(root, "streams"),
    });
    await appendFile(transcriptPath, secondLine);
    const receipt = await drainNativeWakeSpool({
      admission: port,
      lockPath: path.join(root, "collector.lock"),
      spoolPath,
      statePath: path.join(root, "state.json"),
      streamRoot: path.join(root, "streams"),
    });
    expect(receipt).toMatchObject({ admitted: 1, quarantined: 0 });
    expect(commands).toHaveLength(2);
    const first = commands[0];
    const second = commands[1];
    if (first?._tag !== "accept" || second?._tag !== "accept") {
      throw new Error("expected trusted accept commands");
    }
    expect(second.acceptance.source.fromByte).toBe(Buffer.byteLength(firstLine));
    expect(second.acceptance.previousTranscriptHash).toBe(first.acceptance.transcriptHash);
    expect(second.acceptance.runId).not.toBe(first.acceptance.runId);
  });

  it("recovers a pre-admission intent across an admit crash before source growth", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fm-collector-admit-cut-"));
    const transcriptPath = path.join(root, "session.jsonl");
    const spoolPath = path.join(root, "wake.jsonl");
    const firstLine = '{"role":"user","message":"intent-first"}\n';
    const secondLine = '{"role":"assistant","message":"intent-growth"}\n';
    await writeFile(transcriptPath, firstLine);
    const decoded = decodeNativeEvent("pi", {
      event_name: "turn_end",
      occurred_at: "2026-08-22T00:00:00.000Z",
      session_id: "trusted-admit-cut-session",
      transcript_path: transcriptPath,
    });
    if (decoded._tag !== "Accepted") throw new Error("expected trusted wake");
    const commands: AdmissionCommandV1[] = [];
    const accepted = new Map<string, string>();
    const port = makeTrustedNativeAdmissionPort({
      config: {
        adapterInstanceIdHash: "a".repeat(64),
        canonicalRepository: "github.com/joelhooks/joelclaw-memory",
        principalIdHash: "b".repeat(64),
        privacy: "private",
        project: "joelclaw-memory",
        repositoryHost: "github.com",
        repositoryName: "joelclaw-memory",
        repositoryOwner: "joelhooks",
        workstream: "prototype",
      },
      evidenceDirectory: path.join(root, "evidence"),
      ledger: {
        admit: async (command) => {
          const typed = command as AdmissionCommandV1;
          if (typed._tag !== "accept") throw new Error("expected trusted accept");
          const fingerprint = JSON.stringify(typed.acceptance);
          const prior = accepted.get(typed.acceptance.eventId);
          if (prior !== undefined && prior !== fingerprint) {
            throw new Error("immutable-evidence-identity-conflict");
          }
          accepted.set(typed.acceptance.eventId, fingerprint);
          commands.push(typed);
          return {
            captureEventId: typed.acceptance.eventId,
            commandFingerprint: "c".repeat(64),
            disposition: prior === undefined ? "admitted" : "replay",
            invocationId: "d".repeat(64),
            schemaVersion: 1,
            sourceStreamId: typed.acceptance.source.sourceStreamId,
            windowSeq: commands.length,
          } as never;
        },
      },
    });
    await appendNativeWake(spoolPath, decoded.wake);
    let crash = true;
    const afterAdmission = async () => {
      if (crash) {
        crash = false;
        throw new Error("synthetic-admit-cut");
      }
    };
    const first = await drainNativeWakeSpool({
      admission: port,
      afterAdmission,
      lockPath: path.join(root, "collector.lock"),
      spoolPath,
      statePath: path.join(root, "state.json"),
      streamRoot: path.join(root, "streams"),
    });
    expect(first).toMatchObject({ deferred: 1, processed: 1 });
    await appendFile(transcriptPath, secondLine);
    const retry = await drainNativeWakeSpool({
      admission: port,
      lockPath: path.join(root, "collector.lock"),
      spoolPath,
      statePath: path.join(root, "state.json"),
      streamRoot: path.join(root, "streams"),
    });
    expect(retry).toMatchObject({ deferred: 1, processed: 1, quarantined: 0 });
    const growthWake = decodeNativeEvent("pi", {
      event_name: "turn_end",
      occurred_at: "2026-08-22T00:00:01.000Z",
      session_id: "trusted-admit-cut-session",
      transcript_path: transcriptPath,
    });
    if (growthWake._tag !== "Accepted") throw new Error("expected growth wake");
    await appendNativeWake(spoolPath, growthWake.wake);
    const growth = await drainNativeWakeSpool({
      admission: port,
      lockPath: path.join(root, "collector.lock"),
      spoolPath,
      statePath: path.join(root, "state.json"),
      streamRoot: path.join(root, "streams"),
    });
    expect(growth).toMatchObject({ admitted: 1, quarantined: 0 });
    expect(commands).toHaveLength(3);
    const firstCommand = commands[0];
    const retryCommand = commands[1];
    const growthCommand = commands[2];
    if (
      firstCommand?._tag !== "accept" ||
      retryCommand?._tag !== "accept" ||
      growthCommand?._tag !== "accept"
    ) {
      throw new Error("expected trusted accept commands");
    }
    expect(retryCommand.acceptance.eventId).toBe(firstCommand.acceptance.eventId);
    expect(retryCommand.acceptance.transcriptHash).toBe(firstCommand.acceptance.transcriptHash);
    expect(growthCommand.acceptance.eventId).not.toBe(firstCommand.acceptance.eventId);
    expect(growthCommand.acceptance.source.fromByte).toBe(Buffer.byteLength(firstLine));
  });

  it("recovers a pending growth intent before committed stream state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fm-collector-committed-growth-cut-"));
    const transcriptPath = path.join(root, "session.jsonl");
    const spoolPath = path.join(root, "wake.jsonl");
    const firstLine = '{"role":"user","message":"committed-first"}\n';
    const secondLine = '{"role":"assistant","message":"committed-growth"}\n';
    const thirdLine = '{"role":"user","message":"later-growth"}\n';
    await writeFile(transcriptPath, firstLine);
    const firstWake = decodeNativeEvent("pi", {
      event_name: "turn_end",
      occurred_at: "2026-08-22T00:00:00.000Z",
      session_id: "committed-growth-session",
      transcript_path: transcriptPath,
    });
    if (firstWake._tag !== "Accepted") throw new Error("expected first wake");
    const growthWake = decodeNativeEvent("pi", {
      event_name: "turn_end",
      occurred_at: "2026-08-22T00:00:01.000Z",
      session_id: "committed-growth-session",
      transcript_path: transcriptPath,
    });
    if (growthWake._tag !== "Accepted") throw new Error("expected growth wake");
    const commands: AdmissionCommandV1[] = [];
    const accepted = new Map<string, string>();
    const port = makeTrustedNativeAdmissionPort({
      config: {
        adapterInstanceIdHash: "a".repeat(64),
        canonicalRepository: "github.com/joelhooks/joelclaw-memory",
        principalIdHash: "b".repeat(64),
        privacy: "private",
        project: "joelclaw-memory",
        repositoryHost: "github.com",
        repositoryName: "joelclaw-memory",
        repositoryOwner: "joelhooks",
        workstream: "prototype",
      },
      evidenceDirectory: path.join(root, "evidence"),
      ledger: {
        admit: async (command) => {
          const typed = command as AdmissionCommandV1;
          if (typed._tag !== "accept") throw new Error("expected trusted accept");
          const fingerprint = JSON.stringify(typed.acceptance);
          const prior = accepted.get(typed.acceptance.eventId);
          if (prior !== undefined && prior !== fingerprint) {
            throw new Error("immutable-evidence-identity-conflict");
          }
          accepted.set(typed.acceptance.eventId, fingerprint);
          commands.push(typed);
          return {
            captureEventId: typed.acceptance.eventId,
            commandFingerprint: "c".repeat(64),
            disposition: prior === undefined ? "admitted" : "replay",
            invocationId: "d".repeat(64),
            schemaVersion: 1,
            sourceStreamId: typed.acceptance.source.sourceStreamId,
            windowSeq: commands.length,
          } as never;
        },
      },
    });
    await appendNativeWake(spoolPath, firstWake.wake);
    const initial = await drainNativeWakeSpool({
      admission: port,
      lockPath: path.join(root, "collector.lock"),
      spoolPath,
      statePath: path.join(root, "state.json"),
      streamRoot: path.join(root, "streams"),
    });
    expect(initial).toMatchObject({ admitted: 1, quarantined: 0 });

    await appendFile(transcriptPath, secondLine);
    await appendNativeWake(spoolPath, growthWake.wake);
    let crash = true;
    const second = await drainNativeWakeSpool({
      admission: port,
      afterAdmission: async () => {
        if (crash) {
          crash = false;
          throw new Error("synthetic-committed-growth-cut");
        }
      },
      lockPath: path.join(root, "collector.lock"),
      spoolPath,
      statePath: path.join(root, "state.json"),
      streamRoot: path.join(root, "streams"),
    });
    expect(second).toMatchObject({ deferred: 1, processed: 1 });

    await appendFile(transcriptPath, thirdLine);
    const recovered = await drainNativeWakeSpool({
      admission: port,
      lockPath: path.join(root, "collector.lock"),
      spoolPath,
      statePath: path.join(root, "state.json"),
      streamRoot: path.join(root, "streams"),
    });
    expect(recovered).toMatchObject({ deferred: 1, processed: 1, quarantined: 0, replayed: 1 });
    const later = await drainNativeWakeSpool({
      admission: port,
      lockPath: path.join(root, "collector.lock"),
      spoolPath,
      statePath: path.join(root, "state.json"),
      streamRoot: path.join(root, "streams"),
    });
    expect(later).toMatchObject({ admitted: 1, quarantined: 0 });
    expect(commands).toHaveLength(4);
    const firstCommand = commands[0];
    const growthAttempt = commands[1];
    const growthReplay = commands[2];
    const laterGrowth = commands[3];
    if (
      firstCommand?._tag !== "accept" ||
      growthAttempt?._tag !== "accept" ||
      growthReplay?._tag !== "accept" ||
      laterGrowth?._tag !== "accept"
    ) {
      throw new Error("expected trusted accept commands");
    }
    expect(growthReplay.acceptance).toEqual(growthAttempt.acceptance);
    expect(growthAttempt.acceptance.source.fromByte).toBe(Buffer.byteLength(firstLine));
    expect(laterGrowth.acceptance.source.fromByte).toBe(Buffer.byteLength(firstLine + secondLine));
    expect(growthAttempt.acceptance.runId).not.toBe(firstCommand.acceptance.runId);
    expect(laterGrowth.acceptance.runId).not.toBe(growthAttempt.acceptance.runId);
  });

  it("reclaims a stale drain PID and recovers an acknowledged close in processing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fm-collector-stale-drain-"));
    const transcriptPath = path.join(root, "session.jsonl");
    const spoolPath = path.join(root, "wake.jsonl");
    const processingPath = `${spoolPath}.processing`;
    await writeFile(transcriptPath, '{"role":"user","message":"durable-close"}\n');
    const decoded = decodeNativeEvent("pi", {
      event_name: "session_shutdown",
      occurred_at: "2026-08-22T00:00:00.000Z",
      session_id: "stale-drain-session",
      transcript_path: transcriptPath,
    });
    if (decoded._tag !== "Accepted") throw new Error("expected close wake");
    const lockPath = path.join(root, "collector.sock.drain.lock");
    await writeFile(
      lockPath,
      JSON.stringify({
        lockPath,
        pid: 999_999_999,
        schemaVersion: 1,
        token: "stale-drain-token",
      }),
    );
    await writeFile(processingPath, `${JSON.stringify(decoded.wake)}\n`);
    let finalized = 0;
    const receipt = await drainNativeWakeSpool({
      admission: {
        admit: async (input) => {
          if (input.wake.close) finalized += 1;
          return { disposition: input.wake.close ? "finalized" : "admitted" };
        },
      },
      closeStableMs: 0,
      lockPath,
      spoolPath,
      statePath: path.join(root, "state.json"),
      streamRoot: path.join(root, "streams"),
    });
    expect(receipt).toMatchObject({ admitted: 1, quarantined: 0 });
    expect(finalized).toBe(1);
    expect(await readFile(processingPath, "utf8").catch(() => "")).toBe("");
    const state = JSON.parse(await readFile(path.join(root, "state.json"), "utf8")) as {
      streams: Record<string, { readonly closed?: boolean }>;
    };
    expect(Object.values(state.streams).some((entry) => entry.closed === true)).toBe(true);
  });

  it("allows only one reclaimer to own a stale drain lock", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fm-collector-reclaim-race-"));
    const transcriptPath = path.join(root, "session.jsonl");
    const spoolPath = path.join(root, "wake.jsonl");
    await writeFile(transcriptPath, '{"role":"user","message":"reclaim-race"}\n');
    const decoded = decodeNativeEvent("pi", {
      event_name: "turn_end",
      occurred_at: "2026-08-22T00:00:00.000Z",
      session_id: "reclaim-race-session",
      transcript_path: transcriptPath,
    });
    if (decoded._tag !== "Accepted") throw new Error("expected wake");
    await appendNativeWake(spoolPath, decoded.wake);
    const lockPath = path.join(root, "collector.sock.drain.lock");
    await writeFile(
      lockPath,
      JSON.stringify({
        lockPath,
        pid: 999_999_999,
        schemaVersion: 1,
        token: "stale-reclaim-race-token",
      }),
    );
    let admissions = 0;
    const options = {
      admission: {
        admit: async () => {
          admissions += 1;
          return { disposition: "admitted" as const };
        },
      },
      lockPath,
      spoolPath,
      statePath: path.join(root, "state.json"),
      streamRoot: path.join(root, "streams"),
    };
    const results = await Promise.allSettled([
      drainNativeWakeSpool(options),
      drainNativeWakeSpool(options),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    if (rejected?.status !== "rejected") throw new Error("expected one rejected reclaimer");
    expect(rejected.reason).toMatchObject({ message: "collector-already-running" });
    expect(admissions).toBe(1);
    await expect(readFile(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(`${lockPath}.reclaim`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers a malformed reclaim marker left by an interrupted adoption", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fm-collector-malformed-marker-"));
    const transcriptPath = path.join(root, "session.jsonl");
    const spoolPath = path.join(root, "wake.jsonl");
    await writeFile(transcriptPath, '{"role":"user","message":"malformed-marker"}\n');
    const wake = decodeNativeEvent("pi", {
      event_name: "turn_end",
      occurred_at: "2026-08-22T00:00:00.000Z",
      session_id: "malformed-marker-session",
      transcript_path: transcriptPath,
    });
    if (wake._tag !== "Accepted") throw new Error("expected malformed marker wake");
    await appendNativeWake(spoolPath, wake.wake);
    const lockPath = path.join(root, "collector.sock.drain.lock");
    await writeFile(
      lockPath,
      JSON.stringify({
        lockPath,
        pid: 999_999_996,
        schemaVersion: 1,
        token: "malformed-marker-lock-token",
      }),
    );
    await writeFile(`${lockPath}.reclaim`, `{"lockPath":"${lockPath}","pid":`);
    let admissions = 0;
    const receipt = await drainNativeWakeSpool({
      admission: {
        admit: async () => {
          admissions += 1;
          return { disposition: "admitted" as const };
        },
      },
      lockPath,
      spoolPath,
      statePath: path.join(root, "state.json"),
      streamRoot: path.join(root, "streams"),
    });
    expect(receipt).toMatchObject({ admitted: 1, quarantined: 0 });
    expect(admissions).toBe(1);
    await expect(readFile(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(`${lockPath}.reclaim`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers crashed reclaim markers and protects a live marker owner", async () => {
    const staleRoot = await mkdtemp(path.join(tmpdir(), "fm-collector-stale-marker-"));
    const staleTranscriptPath = path.join(staleRoot, "session.jsonl");
    const staleSpoolPath = path.join(staleRoot, "wake.jsonl");
    await writeFile(staleTranscriptPath, '{"role":"user","message":"stale-marker"}\n');
    const staleWake = decodeNativeEvent("pi", {
      event_name: "turn_end",
      occurred_at: "2026-08-22T00:00:00.000Z",
      session_id: "stale-marker-session",
      transcript_path: staleTranscriptPath,
    });
    if (staleWake._tag !== "Accepted") throw new Error("expected stale marker wake");
    await appendNativeWake(staleSpoolPath, staleWake.wake);
    const staleLockPath = path.join(staleRoot, "collector.sock.drain.lock");
    await writeFile(
      staleLockPath,
      JSON.stringify({
        lockPath: staleLockPath,
        pid: 999_999_999,
        schemaVersion: 1,
        token: "new-stale-lock-token",
      }),
    );
    await writeFile(
      `${staleLockPath}.reclaim`,
      JSON.stringify({
        lockPath: staleLockPath,
        observedToken: "old-stale-lock-token",
        pid: 999_999_998,
        schemaVersion: 1,
        token: "crashed-reclaimer-token",
      }),
    );
    let staleAdmissions = 0;
    const staleReceipt = await drainNativeWakeSpool({
      admission: {
        admit: async () => {
          staleAdmissions += 1;
          return { disposition: "admitted" as const };
        },
      },
      lockPath: staleLockPath,
      spoolPath: staleSpoolPath,
      statePath: path.join(staleRoot, "state.json"),
      streamRoot: path.join(staleRoot, "streams"),
    });
    expect(staleReceipt).toMatchObject({ admitted: 1, quarantined: 0 });
    expect(staleAdmissions).toBe(1);
    await expect(readFile(staleLockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(`${staleLockPath}.reclaim`)).rejects.toMatchObject({ code: "ENOENT" });

    const liveRoot = await mkdtemp(path.join(tmpdir(), "fm-collector-live-marker-"));
    const liveTranscriptPath = path.join(liveRoot, "session.jsonl");
    const liveSpoolPath = path.join(liveRoot, "wake.jsonl");
    await writeFile(liveTranscriptPath, '{"role":"user","message":"live-marker"}\n');
    const liveWake = decodeNativeEvent("pi", {
      event_name: "turn_end",
      occurred_at: "2026-08-22T00:00:00.000Z",
      session_id: "live-marker-session",
      transcript_path: liveTranscriptPath,
    });
    if (liveWake._tag !== "Accepted") throw new Error("expected live marker wake");
    await appendNativeWake(liveSpoolPath, liveWake.wake);
    const liveLockPath = path.join(liveRoot, "collector.sock.drain.lock");
    await writeFile(
      liveLockPath,
      JSON.stringify({
        lockPath: liveLockPath,
        pid: 999_999_997,
        schemaVersion: 1,
        token: "live-marker-lock-token",
      }),
    );
    await writeFile(
      `${liveLockPath}.reclaim`,
      JSON.stringify({
        lockPath: liveLockPath,
        observedToken: "live-marker-lock-token",
        pid: process.pid,
        schemaVersion: 1,
        token: "live-reclaimer-token",
      }),
    );
    let liveAdmissions = 0;
    await expect(
      drainNativeWakeSpool({
        admission: {
          admit: async () => {
            liveAdmissions += 1;
            return { disposition: "admitted" as const };
          },
        },
        lockPath: liveLockPath,
        spoolPath: liveSpoolPath,
        statePath: path.join(liveRoot, "state.json"),
        streamRoot: path.join(liveRoot, "streams"),
      }),
    ).rejects.toThrow("collector-already-running");
    expect(liveAdmissions).toBe(0);
    await expect(readFile(`${liveLockPath}.reclaim`)).resolves.toBeTruthy();
  });

  it("reclaims a stale collector PID and socket without stealing an active owner", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fm-collector-stale-owner-"));
    const socketPath = path.join(root, "collector.sock");
    await writeFile(`${socketPath}.lock`, JSON.stringify({ pid: 999_999_999, schemaVersion: 1 }));
    await writeFile(socketPath, "stale");
    expect(await inspectNativeCollector(socketPath)).toBe("stale");
    const service = await startNativeCollectorService({
      activeSourceScan: async () => [],
      admission: { admit: async () => ({ disposition: "admitted" }) },
      scanIntervalMs: 10,
      socketPath,
      spoolPath: path.join(root, "wake.jsonl"),
      statePath: path.join(root, "state.json"),
      streamRoot: path.join(root, "streams"),
    });
    expect(await inspectNativeCollector(socketPath)).toBe("active");
    await service.stop();
    expect(await inspectNativeCollector(socketPath)).toBe("absent");
  });

  it("acknowledges socket wakes only after the durable append and preserves close finality", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fm-collector-socket-ack-"));
    const transcriptPath = path.join(root, "session.jsonl");
    const spoolPath = path.join(root, "wake.jsonl");
    await writeFile(transcriptPath, '{"role":"user","message":"close"}\n');
    const close = decodeNativeEvent("pi", {
      event_name: "session_shutdown",
      occurred_at: "2026-08-22T00:00:00.000Z",
      session_id: "socket-close-session",
      transcript_path: transcriptPath,
    });
    if (close._tag !== "Accepted") throw new Error("expected close wake");
    let finalized = 0;
    const service = await startNativeCollectorService({
      activeSourceScan: async () => [],
      admission: {
        admit: async (input) => {
          if (input.wake.close) finalized += 1;
          return { disposition: input.wake.close ? "finalized" : "admitted" };
        },
      },
      closeStableMs: 0,
      scanIntervalMs: 10,
      socketPath: path.join(root, "collector.sock"),
      spoolPath,
      statePath: path.join(root, "state.json"),
      streamRoot: path.join(root, "streams"),
    });
    await submitNativeWake({
      socketPath: path.join(root, "collector.sock"),
      spoolPath,
      wake: close.wake,
    });
    const spoolAfterAck = await readFile(spoolPath, "utf8").catch(() => "");
    await new Promise((resolve) => setTimeout(resolve, 60));
    await service.stop();
    expect(spoolAfterAck).toContain(close.wake.eventId);
    expect(finalized).toBe(1);
    const state = JSON.parse(await readFile(path.join(root, "state.json"), "utf8")) as {
      streams: Record<string, { readonly closed?: boolean }>;
    };
    expect(Object.values(state.streams).some((entry) => entry.closed === true)).toBe(true);
  });

  it("quarantines a rewritten prefix instead of resetting the cursor", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fm-collector-divergence-"));
    const transcriptPath = path.join(root, "session.jsonl");
    const spoolPath = path.join(root, "wake.jsonl");
    await writeFile(transcriptPath, "one\n");
    const first = decodeNativeEvent("pi", wakeInput("pi", transcriptPath));
    if (first._tag !== "Accepted") throw new Error("expected wake");
    await appendNativeWake(spoolPath, first.wake);
    await drainNativeWakeSpool({
      admission: { admit: async () => ({ disposition: "admitted" }) },
      lockPath: path.join(root, "collector.lock"),
      spoolPath,
      statePath: path.join(root, "state.json"),
    });
    await writeFile(transcriptPath, "two\n");
    const second = decodeNativeEvent("pi", {
      ...wakeInput("pi", transcriptPath),
      occurred_at: new Date(Date.now() + 1).toISOString(),
    });
    if (second._tag !== "Accepted") throw new Error("expected wake");
    await appendNativeWake(spoolPath, second.wake);
    const receipt = await drainNativeWakeSpool({
      admission: { admit: async () => ({ disposition: "admitted" }) },
      lockPath: path.join(root, "collector.lock"),
      spoolPath,
      statePath: path.join(root, "state.json"),
    });
    expect(receipt).toMatchObject({ quarantined: 1, admitted: 0 });
    expect(await readFile(`${spoolPath}.quarantine.jsonl`, "utf8")).toContain(
      "source-prefix-diverged",
    );
  });
});

describe("reversible Pi installer", () => {
  it("requires dry-run identity and restores the byte-exact preimage", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fm-installer-"));
    const targetPath = path.join(root, "settings.json");
    const manifestPath = path.join(root, "manifest.json");
    const packageRef = path.join(root, "flowing-memory-host");
    const preimage = '{\n  "packages": ["existing"]\n}\n';
    await writeFile(packageRef, "package\n");
    await writeFile(targetPath, preimage);
    const dryRun = await installPiHook({
      dryRun: true,
      idle: true,
      manifestPath,
      packageRef,
      targetPath,
    });
    const installed = await installPiHook({
      dryRun: false,
      expectedPreimageHash: dryRun.preimageHash,
      idle: true,
      manifestPath,
      packageRef,
      targetPath,
    });
    expect(installed.postWriteHash).toBe(dryRun.postWriteHash);
    await expect(doctorPiHook(manifestPath)).resolves.toMatchObject({
      packagePresent: true,
      state: "installed-canary-unproven",
    });
    await uninstallPiHook(manifestPath);
    expect(await readFile(targetPath, "utf8")).toBe(preimage);
  });

  it("refuses installation while the runtime is active", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fm-installer-active-"));
    await expect(
      installPiHook({
        dryRun: true,
        idle: false,
        manifestPath: path.join(root, "manifest.json"),
        packageRef: "/tmp/flowing-memory-host",
        targetPath: path.join(root, "settings.json"),
      }),
    ).rejects.toThrow("runtime-not-idle");
  });

  it("installs the canonical event set for every JSON runtime", async () => {
    const expected = {
      claude: ["SessionStart", "PostToolBatch", "Stop", "StopFailure", "SessionEnd"],
      codex: ["SessionStart", "PostToolUse", "Stop", "SessionEnd"],
      cursor: ["sessionStart", "afterAgentResponse", "stop", "sessionEnd"],
      grok: ["SessionStart", "Stop", "StopFailure", "StopCancelled", "Notification", "SessionEnd"],
    } as const;
    for (const runtime of ["claude", "codex", "cursor", "grok"] as const) {
      const root = await mkdtemp(path.join(tmpdir(), `fm-${runtime}-installer-`));
      const targetPath = path.join(root, "hooks.json");
      const manifestPath = path.join(root, "manifest.json");
      const preimage =
        JSON.stringify(
          runtime === "cursor"
            ? { hooks: { afterFileEdit: [{ command: "moshi" }] }, version: 1 }
            : { hooks: { Stop: [{ hooks: [{ command: "legacy-capture-session.ts" }] }] } },
          null,
          2,
        ) + "\n";
      await writeFile(targetPath, preimage);
      const fragmentRef = path.join(root, `${runtime}-flowing-memory-hook`);
      await writeFile(fragmentRef, "hook\n");
      const dryRun = await installHookFragment({
        dryRun: true,
        fragmentRef,
        idle: true,
        manifestPath,
        runtime,
        targetPath,
      });
      expect(dryRun.events).toEqual(expected[runtime]);
      expect(await readFile(targetPath, "utf8")).toBe(preimage);
      const installed = await installHookFragment({
        dryRun: false,
        expectedPreimageHash: dryRun.preimageHash,
        fragmentRef,
        idle: true,
        manifestPath,
        runtime,
        targetPath,
      });
      expect(installed.legacyHandlersRemoved).toBe(runtime === "claude" ? 1 : 0);
      const config = JSON.parse(await readFile(targetPath, "utf8")) as {
        hooks: Record<string, readonly { hooks?: readonly { command?: string }[] }[]>;
      };
      expect(Object.keys(config.hooks)).toEqual(
        expect.arrayContaining(expected[runtime].filter((event) => event !== "Notification")),
      );
      for (const event of expected[runtime]) {
        const groups = config.hooks[event] ?? [];
        const matches =
          runtime === "cursor"
            ? groups.filter((group) => (group as { command?: string }).command === fragmentRef)
            : groups.flatMap((group) =>
                (group.hooks ?? []).filter((handler) => handler.command === fragmentRef),
              );
        expect(matches).toHaveLength(1);
      }
      expect(await doctorHookFragment(manifestPath, runtime)).toMatchObject({
        expectedEvents: expected[runtime],
        fragmentPresent: true,
        state: "installed-canary-unproven",
      });
      await uninstallHookFragment(manifestPath);
      expect(await readFile(targetPath, "utf8")).toBe(preimage);
    }
  });

  it("reports release and backup tampering instead of trusting existence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fm-installer-doctor-integrity-"));
    const targetPath = path.join(root, "hooks.json");
    const manifestPath = path.join(root, "manifest.json");
    const fragmentRef = path.join(root, "hook.js");
    await writeFile(targetPath, '{"hooks":{}}\n');
    await writeFile(fragmentRef, "hook\n");
    const dryRun = await installHookFragment({
      dryRun: true,
      fragmentRef,
      idle: true,
      manifestPath,
      runtime: "grok",
      targetPath,
    });
    await installHookFragment({
      dryRun: false,
      expectedPreimageHash: dryRun.preimageHash,
      fragmentRef,
      idle: true,
      manifestPath,
      runtime: "grok",
      targetPath,
    });
    await writeFile(fragmentRef, "tampered\n");
    await writeFile(`${manifestPath}.preimage`, "tampered-backup\n");
    const doctor = await doctorHookFragment(manifestPath, "grok");
    expect(doctor.fragmentHashMatches).toBe(false);
    expect(doctor.backupHashMatches).toBe(false);
    expect(doctor.state).toBe("drifted");
  });

  it("distinguishes a stale collector socket in doctor output", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fm-installer-doctor-stale-collector-"));
    const targetPath = path.join(root, "hooks.json");
    const manifestPath = path.join(root, "manifest.json");
    const fragmentRef = path.join(root, "hook.js");
    const socketPath = path.join(root, "collector.sock");
    await writeFile(targetPath, '{"hooks":{}}\n');
    await writeFile(fragmentRef, "hook\n");
    await writeFile(socketPath, "stale\n");
    const dryRun = await installHookFragment({
      dryRun: true,
      fragmentRef,
      idle: true,
      manifestPath,
      runtime: "grok",
      targetPath,
    });
    await installHookFragment({
      dryRun: false,
      expectedPreimageHash: dryRun.preimageHash,
      fragmentRef,
      idle: true,
      manifestPath,
      runtime: "grok",
      targetPath,
    });
    const previous = process.env.JOELCLAW_FLOWING_MEMORY_COLLECTOR_SOCKET;
    process.env.JOELCLAW_FLOWING_MEMORY_COLLECTOR_SOCKET = socketPath;
    try {
      await expect(doctorHookFragment(manifestPath, "grok")).resolves.toMatchObject({
        collectorPresent: true,
        collectorState: "stale",
      });
    } finally {
      if (previous === undefined) delete process.env.JOELCLAW_FLOWING_MEMORY_COLLECTOR_SOCKET;
      else process.env.JOELCLAW_FLOWING_MEMORY_COLLECTOR_SOCKET = previous;
    }
  });

  it("uses a symlink release for Pi and restores the original link", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fm-pi-link-installer-"));
    const oldRelease = path.join(root, "old-release");
    const newRelease = path.join(root, "new-release");
    const targetPath = path.join(root, "memory-capture");
    const manifestPath = path.join(root, "manifest.json");
    await mkdir(oldRelease);
    await mkdir(newRelease);
    await symlink(oldRelease, targetPath);
    const dryRun = await installHookFragment({
      dryRun: true,
      fragmentRef: newRelease,
      idle: true,
      manifestPath,
      runtime: "pi",
      targetPath,
    });
    expect(dryRun.targetKind).toBe("symlink");
    expect(dryRun.preimageLinkTarget).toBe(oldRelease);
    await installHookFragment({
      dryRun: false,
      expectedPreimageHash: dryRun.preimageHash,
      fragmentRef: newRelease,
      idle: true,
      manifestPath,
      runtime: "pi",
      targetPath,
    });
    expect(await readlink(targetPath)).toBe(newRelease);
    expect((await lstat(targetPath)).isSymbolicLink()).toBe(true);
    await uninstallHookFragment(manifestPath);
    expect(await readlink(targetPath)).toBe(oldRelease);
  });

  it("prepares every target before writing and restores all targets as one batch", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fm-all-installer-"));
    const runtimes = ["claude", "codex", "cursor", "grok"] as const;
    const inputs = await Promise.all(
      runtimes.map(async (runtime) => {
        const targetPath = path.join(root, `${runtime}.json`);
        const manifestPath = path.join(root, `${runtime}.manifest.json`);
        await writeFile(targetPath, '{"hooks":{}}\n');
        return {
          dryRun: true,
          fragmentRef: `/tmp/${runtime}-hook`,
          idle: true,
          manifestPath,
          runtime,
          targetPath,
        } as const;
      }),
    );
    const dryRuns = await installHookFragments(inputs);
    const before = await Promise.all(inputs.map((input) => readFile(input.targetPath)));
    expect(dryRuns).toHaveLength(4);
    expect(before.map((bytes) => bytes.toString())).toEqual([
      '{"hooks":{}}\n',
      '{"hooks":{}}\n',
      '{"hooks":{}}\n',
      '{"hooks":{}}\n',
    ]);
    const installed = await installHookFragments(
      inputs.map((input, index) => {
        const expectedPreimageHash = dryRuns[index]?.preimageHash;
        if (expectedPreimageHash === undefined) throw new Error("missing dry-run receipt");
        return { ...input, dryRun: false, expectedPreimageHash };
      }),
    );
    expect(installed).toHaveLength(4);
    const uninstalled = await uninstallHookFragments(inputs.map((input) => input.manifestPath));
    expect(uninstalled).toHaveLength(4);
    expect(await Promise.all(inputs.map((input) => readFile(input.targetPath, "utf8")))).toEqual([
      '{"hooks":{}}\n',
      '{"hooks":{}}\n',
      '{"hooks":{}}\n',
      '{"hooks":{}}\n',
    ]);
  });

  it("removes only owned fragments and preserves later unrelated edits", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fm-targeted-uninstall-"));
    const targetPath = path.join(root, "hooks.json");
    const manifestPath = path.join(root, "manifest.json");
    const fragmentRef = path.join(root, "hook");
    await writeFile(fragmentRef, "hook\n");
    await writeFile(targetPath, '{"hooks":{}}\n');
    const dryRun = await installHookFragment({
      dryRun: true,
      fragmentRef,
      idle: true,
      manifestPath,
      runtime: "grok",
      targetPath,
    });
    await installHookFragment({
      dryRun: false,
      expectedPreimageHash: dryRun.preimageHash,
      fragmentRef,
      idle: true,
      manifestPath,
      runtime: "grok",
      targetPath,
    });
    const current = JSON.parse(await readFile(targetPath, "utf8")) as {
      hooks: Record<string, unknown[]>;
    };
    current.hooks.UserPromptSubmit = [{ hooks: [{ command: "unrelated-later-edit" }] }];
    await writeFile(targetPath, `${JSON.stringify(current)}\n`);
    await uninstallHookFragment(manifestPath);
    const restored = JSON.parse(await readFile(targetPath, "utf8")) as {
      hooks: Record<string, unknown[]>;
    };
    expect(restored.hooks.UserPromptSubmit).toBeDefined();
    expect(JSON.stringify(restored)).toContain("unrelated-later-edit");
    expect(JSON.stringify(restored)).not.toContain(fragmentRef);
  });

  it("rolls back a target whose post-write readback fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fm-installer-rollback-"));
    const inputs = (["claude", "grok"] as const).map((runtime) => ({
      dryRun: true,
      fragmentRef: path.join(root, `${runtime}-hook`),
      idle: true,
      manifestPath: path.join(root, `${runtime}.manifest.json`),
      runtime,
      targetPath: path.join(root, `${runtime}.json`),
    }));
    await Promise.all(inputs.map(async (input) => writeFile(input.targetPath, '{"hooks":{}}\n')));
    const dryRuns = await installHookFragments(inputs);
    const installInputs = inputs.map((input, index) => {
      const expectedPreimageHash = dryRuns[index]?.preimageHash;
      if (expectedPreimageHash === undefined) throw new Error("missing dry-run hash");
      return {
        ...input,
        dryRun: false,
        ...(index === 0 ? { faultInjection: "post-write-readback" as const } : {}),
        expectedPreimageHash,
      };
    });
    await expect(installHookFragments(installInputs)).rejects.toThrow(
      "installer-fault-post-write-readback",
    );
    expect(await Promise.all(inputs.map((input) => readFile(input.targetPath, "utf8")))).toEqual([
      '{"hooks":{}}\n',
      '{"hooks":{}}\n',
    ]);
    expect(
      await Promise.all(inputs.map((input) => readFile(input.manifestPath).catch(() => undefined))),
    ).toEqual([undefined, undefined]);
  });

  it("attempts and reports every target during a multi-target rollback", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fm-installer-rollback-all-"));
    const inputs = (["claude", "grok"] as const).map((runtime) => ({
      dryRun: true,
      fragmentRef: path.join(root, `${runtime}-hook`),
      idle: true,
      manifestPath: path.join(root, `${runtime}.manifest.json`),
      runtime,
      targetPath: path.join(root, `${runtime}.json`),
    }));
    await Promise.all(inputs.map((input) => writeFile(input.targetPath, '{"hooks":{}}\n')));
    const dryRuns = await installHookFragments(inputs);
    const installInputs = inputs.map((input, index) => {
      const expectedPreimageHash = dryRuns[index]?.preimageHash;
      if (expectedPreimageHash === undefined) {
        throw new Error("missing dry-run hash");
      }
      return {
        ...input,
        dryRun: false,
        expectedPreimageHash,
        ...(index === 0
          ? { faultInjection: "post-write-readback" as const }
          : { faultInjection: "rollback-restore" as const }),
      };
    });
    await expect(installHookFragments(installInputs)).rejects.toThrow("installer-rollback-failed");
    expect(await readFile(inputs[0]?.targetPath ?? "", "utf8")).toBe('{"hooks":{}}\n');
    await expect(readFile(inputs[1]?.targetPath ?? "", "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses a changed target after dry-run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fm-drift-installer-"));
    const targetPath = path.join(root, "hooks.json");
    const manifestPath = path.join(root, "manifest.json");
    await writeFile(targetPath, '{"hooks":{}}\n');
    const dryRun = await installHookFragment({
      dryRun: true,
      fragmentRef: "/tmp/drift-hook",
      idle: true,
      manifestPath,
      runtime: "grok",
      targetPath,
    });
    await writeFile(targetPath, '{"hooks":{"Stop":[]}}\n');
    await expect(
      installHookFragment({
        dryRun: false,
        expectedPreimageHash: dryRun.preimageHash,
        fragmentRef: "/tmp/drift-hook",
        idle: true,
        manifestPath,
        runtime: "grok",
        targetPath,
      }),
    ).rejects.toThrow("installer-target-changed-after-dry-run");
  });
});

describe("canonical runtime hook map", () => {
  it("exposes exactly the accepted five-runtime event sets", () => {
    expect(runtimeHookEvents("pi")).toEqual(["session_start", "turn_end", "session_shutdown"]);
    expect(runtimeHookEvents("claude")).toEqual([
      "SessionStart",
      "PostToolBatch",
      "Stop",
      "StopFailure",
      "SessionEnd",
    ]);
    expect(runtimeHookEvents("codex")).toEqual([
      "SessionStart",
      "PostToolUse",
      "Stop",
      "SessionEnd",
    ]);
    expect(runtimeHookEvents("cursor")).toEqual([
      "sessionStart",
      "afterAgentResponse",
      "stop",
      "sessionEnd",
    ]);
    expect(runtimeHookEvents("grok")).toEqual([
      "SessionStart",
      "Stop",
      "StopFailure",
      "StopCancelled",
      "Notification",
      "SessionEnd",
    ]);
  });
});
