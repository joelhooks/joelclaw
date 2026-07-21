#!/usr/bin/env node
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readReplayDay } from "../server/journal-spool-source.mjs";
import { buildDecisionPrompt, extractJsonObject, validateAndBuildReceipts } from "../server/replay-core.mjs";
import { buildReviewNote } from "./render-review.mjs";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(pluginRoot, "../../..");
const args = process.argv.slice(2);
const valueOf = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const day = valueOf("--day", "2026-07-20");
const model = valueOf("--model", process.env.JOELCLAW_REPLAY_PI_MODEL || "openai-codex/gpt-5.6-sol");
const outDir = resolve(valueOf("--out", join(repoRoot, ".brain", "data", "agent-comms-gateway", `replay-${day}`)));
const reviewPath = resolve(valueOf("--review", join(repoRoot, ".brain", "projects", "agent-comms-gateway", `review-decision-loop-replay-${day}.svx`)));
const generatedAt = new Date().toISOString();
const runId = `replay-${day}-${generatedAt.replace(/\D/gu, "")}`;

const lifecycle = [];
let state = "idle";
function transition(next, detail = {}) {
  const allowed = {
    idle: ["reading"],
    reading: ["inferring", "failed"],
    inferring: ["validating", "failed"],
    validating: ["inferring", "writing", "failed"],
    writing: ["complete", "failed"],
    complete: [],
    failed: [],
  };
  if (!allowed[state]?.includes(next)) throw new Error(`Invalid replay transition ${state} -> ${next}`);
  state = next;
  lifecycle.push({ state: next, at: new Date().toISOString(), ...detail });
  console.error(`[replay] ${next}${detail.attempt ? ` attempt=${detail.attempt}` : ""}`);
}

async function readPrompts() {
  return Promise.all(["identity.md", "vocabulary.md", "judgment.md"].map((name) =>
    readFile(join(pluginRoot, "prompts", name), "utf8")));
}

function infer(prompt) {
  const result = spawnSync("pi", [
    "-p",
    "--no-session",
    "--no-extensions",
    "--tools",
    "",
    "--model",
    model,
    prompt,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 20 * 60 * 1000,
    env: { ...process.env, NO_COLOR: "1" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Pi inference failed (${result.status}): ${result.stderr.trim()}`);
  return result.stdout;
}

async function writePrivate(path, content) {
  await writeFile(path, content, "utf8");
  await chmod(path, 0o600);
}

async function main() {
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  try {
    await writePrivate(join(outDir, "status.json"), `${JSON.stringify({ runId, state: "running", generatedAt }, null, 2)}\n`);
    transition("reading");
    const [replay, promptFiles] = await Promise.all([readReplayDay({ day }), readPrompts()]);
    if (replay.inputCount === 0) throw new Error(`No outbound request events found for ${day}`);
    const basePrompt = buildDecisionPrompt(replay.inputs, promptFiles);

    let receipts;
    let rawOutput = "";
    let validationError = "";
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      transition("inferring", { attempt });
      const repair = validationError
        ? `\n\nYour prior output failed validation: ${validationError}. Return a complete corrected JSON object.\n`
        : "";
      rawOutput = infer(`${basePrompt}${repair}`);
      await writePrivate(join(outDir, `inference-attempt-${attempt}.txt`), rawOutput);
      transition("validating", { attempt });
      try {
        receipts = validateAndBuildReceipts(extractJsonObject(rawOutput), replay.inputs, generatedAt);
        break;
      } catch (error) {
        validationError = error instanceof Error ? error.message : String(error);
        if (attempt === 3) throw error;
      }
    }
    if (!receipts) throw new Error("Inference did not produce receipts");

    transition("writing");
    await writePrivate(join(outDir, "input.json"), `${JSON.stringify(replay, null, 2)}\n`);
    await writePrivate(join(outDir, "decisions.json"), `${JSON.stringify(receipts, null, 2)}\n`);
    await writePrivate(join(outDir, "decisions.jsonl"), `${receipts.map((receipt) => JSON.stringify(receipt)).join("\n")}\n`);
    const summary = {
      schemaVersion: 1,
      runId,
      day,
      generatedAt,
      inference: { engine: "pi", model },
      source: replay.source,
      sourcePath: replay.sourcePath,
      journalEventCount: replay.journalEventCount,
      inputCount: replay.inputCount,
      decisionReceiptCount: receipts.length,
      coveredInputCount: receipts.reduce((sum, receipt) => sum + receipt.inputEventIds.length, 0),
      counts: Object.fromEntries(["deliver", "hold", "aggregate", "escalate"].map((decision) => [decision, receipts.filter((receipt) => receipt.decision === decision).length])),
      lifecycle,
      regenerate: `node prototypes/agent-comms-gateway/claude-plugin/scripts/run-replay.mjs --day ${day}`,
    };
    await writePrivate(join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    await writePrivate(reviewPath, buildReviewNote(replay, receipts, generatedAt));
    transition("complete");
    summary.lifecycle = lifecycle;
    await writePrivate(join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    await writePrivate(join(outDir, "status.json"), `${JSON.stringify({ runId, state: "complete", generatedAt, completedAt: lifecycle.at(-1)?.at }, null, 2)}\n`);
    console.log(JSON.stringify({ ok: true, outDir, reviewPath, summary }, null, 2));
  } catch (error) {
    if (state !== "failed") transition("failed", { error: error instanceof Error ? error.message : String(error) });
    const failure = { runId, state: "failed", day, generatedAt, artifactsAreStale: true, lifecycle };
    await writePrivate(join(outDir, "failed.json"), `${JSON.stringify(failure, null, 2)}\n`);
    await writePrivate(join(outDir, "status.json"), `${JSON.stringify(failure, null, 2)}\n`);
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
