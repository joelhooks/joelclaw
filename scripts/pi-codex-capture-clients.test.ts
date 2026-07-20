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
import { pathToFileURL } from "node:url";

type CaptureBody = {
  run_id: string;
  agent_runtime: string;
  source_identity: string;
  from_offset: number;
  to_offset: number;
  jsonl_sha256: string;
  jsonl: string;
};

let fixtureRoot: string | undefined;

afterEach(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = undefined;
});

function createFixture() {
  fixtureRoot = mkdtempSync(join(tmpdir(), "capture-clients-"));
  const configDir = join(fixtureRoot, ".joelclaw");
  mkdirSync(configDir, { recursive: true });
  const authPath = join(configDir, "auth.json");
  writeFileSync(
    authPath,
    JSON.stringify({ user_id: "user", machine_id: "machine", token: "fixture-token" }),
  );
  return { root: fixtureRoot, configDir, authPath };
}

function failingCentral(requests: CaptureBody[]) {
  return Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push((await request.json()) as CaptureBody);
      return Response.json({ ok: false, error: "fixture failure" }, { status: 503 });
    },
  });
}

function assertCoalesced(requests: CaptureBody[], configDir: string, expectedJsonl: string) {
  expect(requests).toHaveLength(3);
  expect(new Set(requests.map((request) => request.run_id)).size).toBe(1);
  expect(new Set(requests.map((request) => request.source_identity)).size).toBe(1);
  const files = readdirSync(join(configDir, "outbox"));
  expect(files).toHaveLength(1);
  const pending = JSON.parse(
    readFileSync(join(configDir, "outbox", files[0]), "utf8"),
  ) as CaptureBody;
  expect(pending.run_id).toBe(requests[0].run_id);
  expect(pending.from_offset).toBe(0);
  expect(pending.to_offset).toBe(Buffer.byteLength(expectedJsonl));
  expect(pending.jsonl).toBe(expectedJsonl);
  expect(pending.jsonl_sha256).toBe(
    createHash("sha256").update(Buffer.from(expectedJsonl)).digest("hex"),
  );
  expect(pending.source_identity).toMatch(/^sha256:[0-9a-f]{64}$/u);
}

async function invokePiCapture(input: {
  root: string;
  authPath: string;
  centralUrl: string;
  sessionId: string;
  transcriptPath: string;
}) {
  const moduleUrl = pathToFileURL(
    join(process.cwd(), "packages", "pi-extensions", "memory-capture", "index.ts"),
  ).href;
  const program = `
    import memoryCapture from ${JSON.stringify(moduleUrl)};
    const handlers = {};
    memoryCapture({ on(name, handler) { handlers[name] = handler; } });
    await handlers.turn_end({}, {
      sessionManager: {
        getSessionId: () => ${JSON.stringify(input.sessionId)},
        getSessionFile: () => ${JSON.stringify(input.transcriptPath)},
      },
    });
  `;
  const child = Bun.spawn([process.execPath, "-e", program], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: input.root,
      JOELCLAW_AUTH_PATH: input.authPath,
      JOELCLAW_CENTRAL_URL: input.centralUrl,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await child.exited).toBe(0);
}

async function invokeCodexCapture(input: {
  root: string;
  authPath: string;
  centralUrl: string;
  sessionId: string;
  transcriptPath: string;
}) {
  const child = Bun.spawn(
    [process.execPath, "scripts/joelclaw-capture-codex-session.js"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: input.root,
        JOELCLAW_AUTH_PATH: input.authPath,
        JOELCLAW_CENTRAL_URL: input.centralUrl,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  child.stdin.write(
    JSON.stringify({ session_id: input.sessionId, transcript_path: input.transcriptPath }),
  );
  child.stdin.end();
  expect(await child.exited).toBe(0);
  expect(JSON.parse(await new Response(child.stdout).text())).toMatchObject({ continue: true });
}

const lines = [
  `${JSON.stringify({ type: "message", message: { role: "assistant", content: "🧀" } })}\n`,
  `${JSON.stringify({ type: "message", message: { role: "assistant", content: "第二" } })}\n`,
  `${JSON.stringify({ type: "message", message: { role: "assistant", content: "café" } })}\n`,
];

describe("capture client fixtures", () => {
  test("Pi coalesces repeated failures under one byte-accurate pending Run", async () => {
    const fixture = createFixture();
    const transcriptPath = join(fixture.root, "pi-session.jsonl");
    const requests: CaptureBody[] = [];
    const central = failingCentral(requests);
    try {
      writeFileSync(transcriptPath, lines[0]);
      for (let index = 0; index < lines.length; index += 1) {
        if (index > 0) appendFileSync(transcriptPath, lines[index]);
        await invokePiCapture({
          ...fixture,
          centralUrl: `http://127.0.0.1:${central.port}`,
          sessionId: "pi-session",
          transcriptPath,
        });
      }
      assertCoalesced(requests, fixture.configDir, lines.join(""));
      expect(requests.every((request) => request.agent_runtime === "pi")).toBe(true);
    } finally {
      central.stop(true);
    }
  });

  test("Codex coalesces repeated failures under one byte-accurate pending Run", async () => {
    const fixture = createFixture();
    const transcriptPath = join(fixture.root, "codex-session.jsonl");
    const requests: CaptureBody[] = [];
    const central = failingCentral(requests);
    try {
      writeFileSync(transcriptPath, lines[0]);
      for (let index = 0; index < lines.length; index += 1) {
        if (index > 0) appendFileSync(transcriptPath, lines[index]);
        await invokeCodexCapture({
          ...fixture,
          centralUrl: `http://127.0.0.1:${central.port}`,
          sessionId: "codex-session",
          transcriptPath,
        });
      }
      assertCoalesced(requests, fixture.configDir, lines.join(""));
      expect(requests.every((request) => request.agent_runtime === "codex")).toBe(true);
    } finally {
      central.stop(true);
    }
  });
});
