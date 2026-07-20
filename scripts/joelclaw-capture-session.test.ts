import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CaptureBody } from "./lib/capture-outbox-replay";

let fixtureRoot: string | undefined;

afterEach(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = undefined;
});

async function runHook(
  home: string,
  contextPath: string,
  centralUrl = "http://127.0.0.1:9",
): Promise<void> {
  const child = Bun.spawn(
    [process.execPath, "scripts/joelclaw-capture-session.ts", "--file", contextPath],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        JOELCLAW_AUTH_PATH: join(home, ".joelclaw", "auth.json"),
        JOELCLAW_CENTRAL_URL: centralUrl,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(await child.exited).toBe(0);
}

describe("Claude capture hook", () => {
  test("coalesces later bytes into one pending stale-cursor segment", async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "capture-hook-fixture-"));
    const configDir = join(fixtureRoot, ".joelclaw");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "auth.json"),
      JSON.stringify({ user_id: "user", machine_id: "machine", token: "fixture-token" }),
    );
    const transcriptPath = join(fixtureRoot, "session.jsonl");
    const firstLine = `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: "one" } })}\n`;
    const secondLine = `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: "two" } })}\n`;
    writeFileSync(transcriptPath, firstLine);
    const contextPath = join(fixtureRoot, "hook.json");
    writeFileSync(
      contextPath,
      JSON.stringify({ session_id: "session", transcript_path: transcriptPath }),
    );

    await runHook(fixtureRoot, contextPath);
    const outbox = join(configDir, "outbox");
    const [pendingFile] = readdirSync(outbox);
    const first = JSON.parse(readFileSync(join(outbox, pendingFile), "utf8")) as CaptureBody;

    appendFileSync(transcriptPath, secondLine);
    await runHook(fixtureRoot, contextPath);
    expect(readdirSync(outbox)).toEqual([pendingFile]);
    const coalesced = JSON.parse(readFileSync(join(outbox, pendingFile), "utf8")) as CaptureBody;

    expect(coalesced.run_id).toBe(first.run_id);
    expect(coalesced.from_offset).toBe(0);
    expect(coalesced.to_offset).toBe(Buffer.byteLength(firstLine + secondLine));
    expect(coalesced.jsonl).toBe(firstLine + secondLine);
    expect(coalesced.jsonl_sha256).toBe(
      createHash("sha256").update(firstLine + secondLine).digest("hex"),
    );
    expect(coalesced.source_identity).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  test("reconciles an accepted prefix after an ambiguous response", async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "capture-hook-fixture-"));
    const configDir = join(fixtureRoot, ".joelclaw");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "auth.json"),
      JSON.stringify({ user_id: "user", machine_id: "machine", token: "fixture-token" }),
    );
    const transcriptPath = join(fixtureRoot, "session.jsonl");
    const firstLine = `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: "one" } })}\n`;
    const secondLine = `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: "two" } })}\n`;
    writeFileSync(transcriptPath, firstLine);
    const contextPath = join(fixtureRoot, "hook.json");
    writeFileSync(
      contextPath,
      JSON.stringify({ session_id: "session", transcript_path: transcriptPath }),
    );

    const requests: CaptureBody[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as CaptureBody;
        requests.push(body);
        if (requests.length === 1) return Response.json({ error: "response lost" }, { status: 500 });
        if (requests.length === 2) {
          return Response.json(
            { ok: true, run_id: requests[0].run_id, to_offset: requests[0].to_offset },
            { status: 202 },
          );
        }
        return Response.json(
          { ok: true, run_id: body.run_id, to_offset: body.to_offset },
          { status: 202 },
        );
      },
    });

    try {
      const centralUrl = `http://127.0.0.1:${server.port}`;
      await runHook(fixtureRoot, contextPath, centralUrl);
      appendFileSync(transcriptPath, secondLine);
      await runHook(fixtureRoot, contextPath, centralUrl);

      const state = JSON.parse(readFileSync(join(configDir, "session-state.json"), "utf8")) as {
        session: { last_byte_offset: number; last_run_id: string };
      };
      expect(state.session.last_byte_offset).toBe(Buffer.byteLength(firstLine));
      expect(state.session.last_run_id).toBe(requests[0].run_id);
      expect(readdirSync(join(configDir, "outbox"))).toEqual([]);

      await runHook(fixtureRoot, contextPath, centralUrl);
      expect(requests).toHaveLength(3);
      expect(requests[1].run_id).toBe(requests[0].run_id);
      expect(requests[2].run_id).not.toBe(requests[0].run_id);
      expect(requests[2].from_offset).toBe(Buffer.byteLength(firstLine));
      expect(requests[2].jsonl).toBe(secondLine);
    } finally {
      server.stop(true);
    }
  });
});
