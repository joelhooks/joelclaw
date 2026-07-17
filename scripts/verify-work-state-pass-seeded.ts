#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

async function run(args: string[]): Promise<Record<string, unknown>> {
  const proc = Bun.spawn(["joelclaw", ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`joelclaw ${args.join(" ")} failed: ${stderr.trim()}`);
  return JSON.parse(stdout) as Record<string, unknown>;
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

const statePath = expandHome(
  process.env.WORK_STATE_PASS_STATE_PATH ?? "~/.joelclaw/work-state-pass.json",
);
if (existsSync(statePath)) {
  const state = JSON.parse(readFileSync(statePath, "utf8")) as {
    notified?: Record<string, unknown>;
  };
  if (state.notified && typeof state.notified === "object") {
    state.notified = Object.fromEntries(
      Object.entries(state.notified).filter(([key]) => !key.startsWith("CSEEDED01:")),
    );
    atomicJson(statePath, state);
  }
}

const sent = await run([
  "send",
  "slack/work-state.pass.requested",
  "-d",
  JSON.stringify({ reason: "seeded enable proof", seededScenario: true }),
]);
const eventId = String(
  ((sent.result as { response?: { ids?: string[] } } | undefined)?.response?.ids ?? [])[0] ?? "",
);
if (!eventId) throw new Error("joelclaw send returned no event ID");

let terminal: Record<string, unknown> | null = null;
for (let attempt = 0; attempt < 45; attempt += 1) {
  const envelope = await run(["event", eventId]);
  const runs = (envelope.result as { runs?: Array<Record<string, unknown>> } | undefined)?.runs ?? [];
  const candidate = runs[0];
  if (candidate && ["COMPLETED", "FAILED", "CANCELLED"].includes(String(candidate.status))) {
    terminal = candidate;
    break;
  }
  await Bun.sleep(1_000);
}
if (!terminal) throw new Error(`Timed out waiting for work-state pass event ${eventId}`);
if (terminal.status !== "COMPLETED") {
  throw new Error(`Seeded work-state pass ended ${String(terminal.status)}`);
}

const output = JSON.parse(String(terminal.output ?? "{}")) as {
  status?: string;
  seededScenario?: boolean;
  findings?: number;
  findingKinds?: { untagged?: number; stale_started?: number };
  pages?: number;
  pagePath?: string;
  newFindings?: number;
  wakes?: number;
};
const assertions = {
  completed: output.status === "completed",
  seededScenario: output.seededScenario === true,
  untaggedFinding: (output.findingKinds?.untagged ?? 0) >= 1,
  staleStartedFinding: (output.findingKinds?.stale_started ?? 0) >= 1,
  pageWritten: output.pages === 1 && Boolean(output.pagePath) && existsSync(output.pagePath ?? ""),
  stateChangeDetected: (output.newFindings ?? 0) >= 2,
  oneWake: output.wakes === 1,
};
const failed = Object.entries(assertions).filter(([, passed]) => !passed).map(([name]) => name);
if (failed.length > 0) {
  throw new Error(`Seeded proof assertions failed: ${failed.join(", ")} output=${JSON.stringify(output)}`);
}

console.log(JSON.stringify({
  ok: true,
  command: "verify work-state pass seeded",
  result: {
    eventId,
    runId: terminal.id,
    assertions,
    output,
  },
}, null, 2));
