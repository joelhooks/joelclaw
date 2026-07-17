#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const path = expandHome(
  option("--path") ??
    process.env.WORK_STATE_PASS_LAST_RUN_PATH ??
    "~/.joelclaw/work-state-pass-last-run.json",
);

if (!existsSync(path)) {
  console.error(JSON.stringify({
    ok: false,
    command: "work-state-pass funnel",
    error: `No work-state pass receipt at ${path}`,
    fix: "Enable and run slack-work-state-pass, then retry this command.",
  }, null, 2));
  process.exit(1);
}

try {
  const receipt = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const required = ["status", "runId", "completedAt", "channelsScanned", "rootsSeen", "findings", "pages", "wakes"];
  const missing = required.filter((key) => receipt[key] === undefined);
  if (missing.length > 0) throw new Error(`receipt missing ${missing.join(", ")}`);

  console.log(JSON.stringify({
    ok: true,
    command: "work-state-pass funnel",
    result: receipt,
    receiptPath: path,
    next_actions: [
      {
        command: "joelclaw otel search \"slack.work_state.pass\" --component work-state-pass --hours 24 --limit 100",
        description: "Inspect per-stage OTEL receipts for this pass",
      },
      receipt.pagePath
        ? { command: `open ${JSON.stringify(String(receipt.pagePath))}`, description: "Open the observation source page" }
        : { command: "bun scripts/work-state-pass-funnel.ts", description: "Check the next pass for findings" },
    ],
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    command: "work-state-pass funnel",
    error: error instanceof Error ? error.message : String(error),
    receiptPath: path,
    fix: "Inspect or replace the malformed last-run receipt by running the pass again.",
  }, null, 2));
  process.exit(1);
}
