#!/usr/bin/env node
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const runtimes = ["pi", "claude-code", "codex"];

export async function resolveReplayModule(home, releaseDir) {
  // Install manifests can lag the live hook targets. Follow the installed Pi
  // target, never a version number or an unchecked shell hook command.
  const root =
    releaseDir ??
    path.resolve(
      await realpath(path.join(home, ".pi", "agent", "extensions", "memory-capture")),
      "..",
      "..",
    );
  const modulePath = await realpath(path.join(root, "owner", "raw-capture.js"));
  const module = await import(pathToFileURL(modulePath).href);
  if (
    typeof module.replayNativeRunCaptureOutboxes !== "function" ||
    typeof module.resolveCaptureEndpoint !== "function"
  ) {
    throw new Error("active release does not export the replay and endpoint APIs");
  }
  return module;
}

export async function countRanges(home, env = process.env, now = Date.now()) {
  const auth = JSON.parse(
    await readFile(env.JOELCLAW_AUTH_PATH ?? path.join(home, ".joelclaw", "auth.json"), "utf8"),
  );
  if (typeof auth.machine_id !== "string" || !auth.machine_id)
    throw new Error("capture auth is invalid");
  const machine = auth.machine_id.replace(/[^a-zA-Z0-9._-]/gu, "_");
  const counts = { ranges: 0, ready: 0, waiting: 0, poisoned: 0, invalid: 0, due: 0, bytes: 0 };
  for (const runtime of runtimes) {
    const dir = path.join(home, ".joelclaw", "capture", machine, runtime, "outbox-ranges");
    let names;
    try {
      names = await readdir(dir);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const name of names.filter((name) => /^range-[a-f0-9]{64}\.json$/u.test(name))) {
      counts.ranges++;
      try {
        const file = path.join(dir, name);
        const info = await lstat(file);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 16_384)
          throw new Error("invalid range metadata");
        const range = JSON.parse(await readFile(file, "utf8"));
        if (
          range.schemaVersion !== 2 ||
          !["ready", "waiting", "poisoned"].includes(range.mode) ||
          !Number.isSafeInteger(range.fromOffset) ||
          !Number.isSafeInteger(range.toOffset) ||
          range.fromOffset < 0 ||
          range.toOffset < range.fromOffset ||
          !Number.isSafeInteger(range.nextAttemptAt)
        )
          throw new Error("invalid range metadata");
        counts[range.mode]++;
        counts.bytes += range.toOffset - range.fromOffset;
        if (range.mode !== "poisoned" && range.nextAttemptAt <= now) counts.due++;
      } catch {
        counts.invalid++;
      }
    }
  }
  return counts;
}

export async function replayOutboxes({
  apply = false,
  calls = 1,
  releaseDir,
  home = process.env.HOME ?? homedir(),
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  if (!Number.isSafeInteger(calls) || calls < 1 || calls > 100)
    throw new Error("calls must be between 1 and 100");
  const before = await countRanges(home, env);
  // Dry count does not import or invoke release code (which can prune ranges).
  if (!apply) return { mode: "dry-run", before };
  const module = await resolveReplayModule(home, releaseDir);
  const endpoint = module.resolveCaptureEndpoint(home, env);
  if (!endpoint.url) throw new Error("capture endpoint is invalid");
  const health = await fetchImpl(`${endpoint.url.replace(/\/$/u, "")}/`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!health.ok) throw new Error("Central health gate failed");
  const body = await health.json();
  if (body.service !== "system-bus" || body.status !== "running")
    throw new Error("Central health gate failed");
  const receipt = { accepted: 0, attempted: 0, failed: 0, invalid: 0, stale: 0 };
  let invocations = 0;
  for (; invocations < calls; ) {
    // Each call keeps the installed release's own time/window budget, auth,
    // backoff, prefix handling, and retention. No custom replay/deletion logic.
    const result = await module.replayNativeRunCaptureOutboxes({ home, env, fetch: fetchImpl });
    invocations++;
    for (const key of Object.keys(receipt)) {
      if (!Number.isSafeInteger(result[key]) || result[key] < 0)
        throw new Error("invalid replay receipt");
      receipt[key] += result[key];
    }
    if (result.attempted === 0 || result.failed > 0 || result.invalid > 0) break;
  }
  return { mode: "apply", before, invocations, ...receipt, after: await countRanges(home, env) };
}

async function main(args) {
  let apply = false,
    calls = 1,
    releaseDir;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--apply") apply = true;
    else if (args[i] === "--dry-run") apply = false;
    else if (args[i] === "--calls") calls = Number(args[++i]);
    else if (args[i] === "--release-dir") releaseDir = args[++i];
    else
      throw new Error(
        "usage: replay-native-capture-outboxes.mjs [--dry-run|--apply] [--calls 1..100] [--release-dir DIR]",
      );
    if (args[i] === undefined) throw new Error("missing option value");
  }
  const result = await replayOutboxes({ apply, calls, releaseDir });
  console.log(JSON.stringify(result));
  if (result.failed > 0 || result.invalid > 0 || result.before.invalid > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => {
    // Keep credentials and local paths out of scheduler logs.
    console.error("native capture replay failed; check active release, auth, and Central health");
    process.exitCode = 1;
  });
}
