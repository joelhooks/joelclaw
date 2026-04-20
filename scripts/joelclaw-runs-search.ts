#!/usr/bin/env bun
/**
 * joelclaw-runs-search — terminal-native search over captured Runs.
 *
 * Usage:
 *   joelclaw-runs-search "query text"
 *   joelclaw-runs-search --mode=semantic "concept"
 *   joelclaw-runs-search --mode=keyword "exact phrase"
 *   joelclaw-runs-search --limit=20 "query"
 *   joelclaw-runs-search --json "query"        # raw API response
 *
 * Reads auth from ~/.joelclaw/auth.json.
 * Targets $JOELCLAW_CENTRAL_URL (default: http://localhost:3000).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CENTRAL_URL = process.env.JOELCLAW_CENTRAL_URL ?? "http://localhost:3000";
const AUTH_PATH = join(homedir(), ".joelclaw", "auth.json");

type Mode = "hybrid" | "semantic" | "keyword";

interface Args {
  query: string;
  mode: Mode;
  limit: number;
  json: boolean;
  tag: string | null;
  runtime: string | null;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    query: "",
    mode: "hybrid",
    limit: 10,
    json: false,
    tag: null,
    runtime: null,
  };
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("--mode=")) {
      out.mode = arg.slice(7) as Mode;
    } else if (arg.startsWith("--limit=")) {
      out.limit = parseInt(arg.slice(8), 10) || 10;
    } else if (arg === "--json") {
      out.json = true;
    } else if (arg.startsWith("--tag=")) {
      out.tag = arg.slice(6);
    } else if (arg.startsWith("--runtime=")) {
      out.runtime = arg.slice(10);
    } else {
      positional.push(arg);
    }
  }
  out.query = positional.join(" ");
  return out;
}

function ansiDim(s: string): string {
  return `\x1b[2m${s}\x1b[0m`;
}
function ansiBold(s: string): string {
  return `\x1b[1m${s}\x1b[0m`;
}
function ansiColor(s: string, code: number): string {
  return `\x1b[${code}m${s}\x1b[0m`;
}

function roleBadge(role: string): string {
  if (role === "user") return ansiColor("user", 36);
  if (role === "assistant") return ansiColor("asst", 32);
  if (role === "tool") return ansiColor("tool", 35);
  return role;
}

function formatRelativeTime(ts: number): string {
  const now = Date.now();
  const delta = now - ts;
  if (delta < 0) return new Date(ts).toISOString().slice(0, 16).replace("T", " ");
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toISOString().slice(0, 10);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.query) {
    console.error(
      'usage: joelclaw-runs-search [--mode=hybrid|semantic|keyword] [--limit=N] [--tag=X] [--runtime=X] [--json] "query"'
    );
    process.exit(1);
  }

  if (!existsSync(AUTH_PATH)) {
    console.error(`auth missing: ${AUTH_PATH}`);
    process.exit(1);
  }
  const auth = JSON.parse(readFileSync(AUTH_PATH, "utf8"));

  const body: Record<string, unknown> = {
    query: args.query,
    mode: args.mode,
    limit: args.limit,
  };
  const filters: Record<string, unknown> = {};
  if (args.tag) filters.tags = [args.tag];
  if (args.runtime) filters.agent_runtime = [args.runtime];
  if (Object.keys(filters).length) body.filters = filters;

  const res = await fetch(`${CENTRAL_URL}/api/runs/search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${auth.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error(`search failed: ${res.status}\n${errText}`);
    process.exit(1);
  }
  const data = (await res.json()) as {
    count: number;
    total_matched: number;
    mode: string;
    hits: Array<{
      run_id: string;
      chunk_idx: number;
      role: string;
      text: string;
      agent_runtime: string;
      tags?: string[];
      conversation_id?: string;
      machine_id: string;
      started_at: number;
      score: { vector_distance?: number; text_match?: number };
    }>;
    timing: Record<string, number>;
  };

  if (args.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const { count, total_matched, mode, hits, timing } = data;
  console.log(
    `${ansiBold(`${count}`)} hits (of ${total_matched}) · ${mode} · ` +
      ansiDim(`embed=${timing.query_embed_ms}ms ts=${timing.typesense_ms}ms total=${timing.total_ms}ms`)
  );
  console.log();

  hits.forEach((h, i) => {
    const idx = ansiDim(`${i + 1}.`);
    const score =
      h.score.vector_distance !== undefined
        ? ansiDim(`vec=${h.score.vector_distance.toFixed(3)}`)
        : h.score.text_match !== undefined
          ? ansiDim(`txt=${h.score.text_match}`)
          : "";
    const when = ansiDim(formatRelativeTime(h.started_at));
    const runtime = ansiDim(`[${h.agent_runtime}]`);
    const tagsStr = h.tags?.length ? ansiDim(` #${h.tags.slice(0, 2).join(" #")}`) : "";
    console.log(
      `${idx} ${roleBadge(h.role)} ${runtime} ${when} ${score}${tagsStr}`
    );
    const snippet = h.text.slice(0, 220).replace(/\s+/g, " ");
    console.log(`   ${snippet}${h.text.length > 220 ? "…" : ""}`);
    console.log(
      ansiDim(`   run=${h.run_id}:${h.chunk_idx}`)
    );
    console.log();
  });
}

main().catch((err) => {
  console.error(`error: ${(err as Error).message}`);
  process.exit(1);
});
