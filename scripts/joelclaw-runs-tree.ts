#!/usr/bin/env bun
/**
 * joelclaw-runs-tree — GLOBAL pi-tree for the joelclaw memory archive.
 *
 * Shows a cross-runtime ASCII tree of every Run the caller can read
 * (own + Share Granted), built from the parent_run_id / root_run_id
 * linkage that every Run carries (ADR-0243 Rule 3).
 *
 * Usage:
 *   joelclaw-runs-tree
 *   joelclaw-runs-tree --since=24h
 *   joelclaw-runs-tree --runtime=claude-code,pi
 *   joelclaw-runs-tree --root=<run-id>        # zoom into a subtree
 *   joelclaw-runs-tree --json                 # raw forest response
 *
 * Inspired by pi's /tree (https://github.com/badlogic/pi-mono). Pi's tree
 * is per-turn within one session; this one is per-Run across all sessions
 * and all runtimes.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CENTRAL_URL = process.env.JOELCLAW_CENTRAL_URL ?? "http://localhost:3000";
const AUTH_PATH = join(homedir(), ".joelclaw", "auth.json");

interface Run {
  id: string;
  user_id: string;
  machine_id: string;
  agent_runtime: string;
  parent_run_id: string | null;
  root_run_id: string | null;
  conversation_id: string | null;
  tags: string[];
  intent: string;
  started_at: number;
  ended_at?: number;
  duration_ms?: number;
  turn_count: number;
  user_turn_count?: number;
  assistant_turn_count?: number;
  tool_turn_count?: number;
  tool_call_count?: number;
  status: string;
}

interface Args {
  since: number;
  runtimes: string[] | null;
  root: string | null;
  json: boolean;
  limit: number;
}

function parseSince(input: string | null): number {
  if (!input) return Date.now() - 7 * 24 * 60 * 60 * 1000;
  const match = input.match(/^(\d+)([smhd])?$/);
  if (!match) return Date.now() - 7 * 24 * 60 * 60 * 1000;
  const num = Number.parseInt(match[1]!, 10);
  const unit = match[2] ?? "s";
  const mult =
    unit === "s"
      ? 1_000
      : unit === "m"
        ? 60_000
        : unit === "h"
          ? 3_600_000
          : 86_400_000;
  return Date.now() - num * mult;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    since: Date.now() - 7 * 24 * 60 * 60 * 1000,
    runtimes: null,
    root: null,
    json: false,
    limit: 500,
  };
  for (const arg of argv) {
    if (arg.startsWith("--since=")) out.since = parseSince(arg.slice(8));
    else if (arg.startsWith("--runtime=")) out.runtimes = arg.slice(10).split(",");
    else if (arg.startsWith("--root=")) out.root = arg.slice(7);
    else if (arg.startsWith("--limit=")) out.limit = Number.parseInt(arg.slice(8), 10) || 500;
    else if (arg === "--json") out.json = true;
  }
  return out;
}

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const MAGENTA = "\x1b[35m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

function runtimeBadge(runtime: string): string {
  const color =
    runtime === "pi"
      ? GREEN
      : runtime === "claude-code"
        ? CYAN
        : runtime === "codex"
          ? MAGENTA
          : runtime === "gateway"
            ? YELLOW
            : runtime === "loop" || runtime === "workload-stage"
              ? RED
              : "";
  return `${color}${runtime}${RESET}`;
}

function relTime(ts: number): string {
  const delta = Date.now() - ts;
  if (delta < 0) return new Date(ts).toISOString().slice(11, 16);
  const m = Math.floor(delta / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ""} ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function machineBadge(machine: string): string {
  // Stable color per machine via a tiny hash so each Machine gets its own
  // hue without a lookup table. Bright colors range 91-97 (magenta..white).
  let h = 0;
  for (let i = 0; i < machine.length; i++) h = (h * 31 + machine.charCodeAt(i)) | 0;
  const code = 91 + (Math.abs(h) % 6);
  return `\x1b[${code}m@${machine}${RESET}`;
}

function summarize(run: Run): string {
  const intent = (run.intent ?? "").replace(/\s+/g, " ").slice(0, 80);
  const duration =
    run.duration_ms && run.duration_ms > 0
      ? `${DIM}${Math.round(run.duration_ms / 1000)}s${RESET}`
      : "";
  const turns = `${DIM}${run.turn_count}t${RESET}`;
  const status =
    run.status === "active" ? "" : `${DIM} [${run.status}]${RESET}`;
  const tags = run.tags?.length
    ? ` ${DIM}${run.tags
        .filter((t) => !t.startsWith("basename:") && !t.startsWith("session:"))
        .slice(0, 3)
        .map((t) => `#${t}`)
        .join(" ")}${RESET}`
    : "";
  return (
    `${runtimeBadge(run.agent_runtime)} ${machineBadge(run.machine_id)} ${DIM}${relTime(run.started_at)}${RESET} ${turns}${duration ? " " + duration : ""}${status}${tags}\n` +
    `   ${BOLD}${intent || "<no intent>"}${RESET}${intent.length === 80 ? "…" : ""}\n` +
    `   ${DIM}${run.id}${RESET}`
  );
}

function renderTree(runs: Run[]): string[] {
  const byId = new Map<string, Run>();
  const children = new Map<string | null, Run[]>();
  for (const r of runs) byId.set(r.id, r);

  // Group by parent. A Run whose parent is missing from our set becomes
  // an orphan root (we still show it).
  for (const r of runs) {
    const parent = r.parent_run_id && byId.has(r.parent_run_id) ? r.parent_run_id : null;
    const bucket = children.get(parent) ?? [];
    bucket.push(r);
    children.set(parent, bucket);
  }

  // Sort every bucket by started_at ascending for deterministic output.
  for (const list of children.values()) {
    list.sort((a, b) => a.started_at - b.started_at);
  }

  const roots = children.get(null) ?? [];
  const lines: string[] = [];

  function walk(node: Run, prefix: string, isLast: boolean) {
    const connector = isLast ? "└─ " : "├─ ";
    const childPrefix = prefix + (isLast ? "   " : "│  ");
    const summary = summarize(node).split("\n");
    lines.push(prefix + connector + summary[0]);
    for (let i = 1; i < summary.length; i++) {
      lines.push(childPrefix + summary[i]);
    }

    const kids = children.get(node.id) ?? [];
    kids.forEach((child, i) => {
      walk(child, childPrefix, i === kids.length - 1);
    });
  }

  roots.forEach((root, i) => {
    walk(root, "", i === roots.length - 1);
    if (i < roots.length - 1) lines.push("");
  });

  return lines;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(AUTH_PATH)) {
    console.error(`auth missing: ${AUTH_PATH}`);
    process.exit(1);
  }
  const auth = JSON.parse(readFileSync(AUTH_PATH, "utf8"));

  const params = new URLSearchParams({
    since: String(args.since),
    limit: String(args.limit),
  });
  if (args.runtimes) params.set("runtime", args.runtimes.join(","));
  if (args.root) params.set("root_run_id", args.root);

  const res = await fetch(`${CENTRAL_URL}/api/runs/forest?${params}`, {
    headers: { Authorization: `Bearer ${auth.token}` },
  });
  if (!res.ok) {
    console.error(`forest fetch failed: ${res.status}\n${await res.text()}`);
    process.exit(1);
  }
  const data = (await res.json()) as {
    count: number;
    total_matched: number;
    roots_count: number;
    runs: Run[];
    window: { since: number; now: number };
  };

  if (args.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (data.runs.length === 0) {
    console.log(`${DIM}no Runs in the window${RESET}`);
    return;
  }

  const since = new Date(data.window.since).toISOString().slice(0, 16);
  console.log(
    `${BOLD}${data.count}${RESET} Runs ${DIM}(${data.roots_count} roots) since ${since}${RESET}`
  );
  console.log();
  for (const line of renderTree(data.runs)) {
    console.log(line);
  }
  console.log();
}

main().catch((err) => {
  console.error(`error: ${(err as Error).message}`);
  process.exit(1);
});
