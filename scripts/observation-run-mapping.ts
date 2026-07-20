#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

type Frontmatter = Record<string, unknown>;
type Confidence = "high" | "medium" | "none";
type MappingKind =
  | "conversation-window"
  | "conversation"
  | "capture-run"
  | "operational-run"
  | "synthetic"
  | "unmapped";

type RunRow = {
  run_id: string;
  conversation_id: string | null;
  started_at: number;
  ended_at: number;
  chunk_count: number;
};

type ChunkRow = {
  run_id: string;
  chunk_idx: number;
  role: string;
  text: string;
  started_at: number;
};

type ObservationPage = {
  path: string;
  slug: string;
  frontmatter: Frontmatter;
  body: string;
};

type Mapping = {
  page: string;
  slug: string;
  observerSessionId: string | null;
  observerRunId: string | null;
  kind: MappingKind;
  confidence: Confidence;
  reason: string;
  candidateRunIds: string[];
  candidateRunCount: number;
  window: { from: number | null; to: number | null };
  bestTranscriptEvidence?: {
    runId: string;
    chunkIdx: number;
    role: string;
    startedAt: string;
    overlapScore: number;
    text: string;
  };
};

const HOME = homedir();
const DEFAULT_OBSERVATIONS = join(HOME, "Code", "joelhooks", "dark-wizard", ".brain", "observations");
const DEFAULT_SESSIONS_DB = join(HOME, ".joelclaw", "search", "sessions.db");
const STOP_WORDS = new Set([
  "about", "after", "again", "also", "been", "before", "being", "between", "could", "from", "have",
  "into", "more", "must", "only", "other", "should", "that", "their", "there", "these", "they", "this",
  "through", "using", "were", "what", "when", "where", "which", "with", "would", "your",
]);

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? resolve(process.argv[index + 1]!) : fallback;
}

function numberOption(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  const parsed = index >= 0 ? Number(process.argv[index + 1]) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function timestamp(value: unknown): number | null {
  const numeric = numberValue(value);
  if (numeric !== null) return numeric > 0 && numeric < 10_000_000_000 ? numeric * 1_000 : numeric;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function walk(root: string): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) paths.push(...walk(path));
    else if (entry.isFile() && entry.name.endsWith(".svx")) paths.push(path);
  }
  return paths.sort();
}

function loadPages(root: string): { pages: ObservationPage[]; malformed: Array<{ path: string; error: string }> } {
  const pages: ObservationPage[] = [];
  const malformed: Array<{ path: string; error: string }> = [];
  for (const path of walk(root)) {
    const raw = readFileSync(path, "utf8");
    const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/u);
    if (!match) {
      malformed.push({ path, error: "missing frontmatter" });
      continue;
    }
    try {
      const frontmatter = Bun.YAML.parse(match[1]!) as Frontmatter;
      if (frontmatter.type !== "observation") continue;
      pages.push({
        path,
        slug: stringValue(frontmatter.slug) ?? basename(path, ".svx"),
        frontmatter,
        body: match[2]!.trim(),
      });
    } catch (error) {
      malformed.push({ path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { pages, malformed };
}

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, " ")
      .split(/\s+/u)
      .filter((token) => token.length >= 4 && !STOP_WORDS.has(token)),
  );
}

function overlapScore(left: Set<string>, rightText: string): number {
  if (!left.size) return 0;
  const right = tokens(rightText);
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap += 1;
  return overlap / Math.sqrt(left.size * Math.max(right.size, 1));
}

function isSyntheticSessionId(sessionId: string): boolean {
  return /^(?:telemetry(?::|-)|reflector-|external-context-|session-noted:|dedup:|otel:)/u.test(sessionId);
}

function mapPage(db: Database, page: ObservationPage): Mapping {
  const fm = page.frontmatter;
  const sessionId = stringValue(fm.sessionId) ?? stringValue(fm.session_id);
  const observerRunId = stringValue(fm.runId) ?? stringValue(fm.run_id);
  const from = timestamp(fm.windowFrom) ?? timestamp(fm.started);
  const to = timestamp(fm.windowTo) ?? timestamp(fm.ended);
  const base = {
    page: page.path,
    slug: page.slug,
    observerSessionId: sessionId,
    observerRunId,
    candidateRunIds: [] as string[],
    candidateRunCount: 0,
    window: { from, to },
  };

  if (sessionId) {
    const conversationRuns = db
      .query("SELECT run_id, conversation_id, started_at, ended_at, chunk_count FROM runs WHERE conversation_id = ? ORDER BY started_at, run_id")
      .all(sessionId) as RunRow[];
    if (conversationRuns.length > 0) {
      let windowRuns: RunRow[] = [];
      if (from !== null && to !== null) {
        windowRuns = db
          .query(`
            SELECT DISTINCT r.run_id, r.conversation_id, r.started_at, r.ended_at, r.chunk_count
            FROM runs r
            JOIN chunks c ON c.run_id = r.run_id
            WHERE r.conversation_id = ? AND c.started_at > ? AND c.started_at <= ?
            ORDER BY r.started_at, r.run_id
          `)
          .all(sessionId, from, to) as RunRow[];
      }
      const candidates = windowRuns.length > 0 ? windowRuns : conversationRuns;
      return {
        ...base,
        kind: windowRuns.length > 0 ? "conversation-window" : "conversation",
        confidence: windowRuns.length > 0 ? "high" : "medium",
        reason: windowRuns.length > 0
          ? "observer sessionId equals capture conversation_id; candidate Runs contain chunks inside the observer epoch"
          : "observer sessionId equals capture conversation_id; no indexed chunk landed inside the recorded epoch, so all conversation Runs remain candidates",
        candidateRunIds: candidates.map((run) => run.run_id),
        candidateRunCount: candidates.length,
      };
    }

    const exactRun = db
      .query("SELECT run_id, conversation_id, started_at, ended_at, chunk_count FROM runs WHERE run_id = ?")
      .get(sessionId) as RunRow | null;
    if (exactRun) {
      return {
        ...base,
        kind: "capture-run",
        confidence: "high",
        reason: "observer fallback sessionId equals a capture run_id",
        candidateRunIds: [exactRun.run_id],
        candidateRunCount: 1,
      };
    }

    if (isSyntheticSessionId(sessionId)) {
      return {
        ...base,
        kind: "synthetic",
        confidence: "none",
        reason: "page records a telemetry, reflector, or external-context identity, not a transcript session",
      };
    }
  }

  if (observerRunId) {
    return {
      ...base,
      kind: "operational-run",
      confidence: "none",
      reason: "runId belongs to the page producer (currently Slack work-state pass), not capture Runs",
    };
  }

  return {
    ...base,
    kind: "unmapped",
    confidence: "none",
    reason: sessionId ? "sessionId does not exist in sessions.db" : "page has no sessionId or capture identity",
  };
}

function addEvidence(db: Database, page: ObservationPage, mapping: Mapping): Mapping {
  if (mapping.candidateRunIds.length === 0) return mapping;
  const candidates = new Set(mapping.candidateRunIds);
  const query = mapping.kind === "conversation-window" && mapping.window.from !== null && mapping.window.to !== null
    ? `SELECT c.run_id, c.chunk_idx, c.role, c.text, c.started_at FROM chunks c JOIN runs r ON r.run_id = c.run_id WHERE r.conversation_id = ? AND c.started_at > ? AND c.started_at <= ?`
    : `SELECT c.run_id, c.chunk_idx, c.role, c.text, c.started_at FROM chunks c JOIN runs r ON r.run_id = c.run_id WHERE r.conversation_id = ?`;
  const rows = mapping.observerSessionId
    ? (mapping.kind === "conversation-window"
        ? db.query(query).all(mapping.observerSessionId, mapping.window.from!, mapping.window.to!)
        : db.query(query).all(mapping.observerSessionId)) as ChunkRow[]
    : (db.query("SELECT run_id, chunk_idx, role, text, started_at FROM chunks WHERE run_id = ?").all(mapping.candidateRunIds[0]!) as ChunkRow[]);
  const pageTokens = tokens(page.body);
  const ranked = rows
    .filter((row) => candidates.has(row.run_id))
    .map((row) => ({ row, score: overlapScore(pageTokens, row.text) }))
    .sort((a, b) => b.score - a.score || b.row.started_at - a.row.started_at);
  const best = ranked[0];
  if (!best) return mapping;
  return {
    ...mapping,
    bestTranscriptEvidence: {
      runId: best.row.run_id,
      chunkIdx: best.row.chunk_idx,
      role: best.row.role,
      startedAt: new Date(best.row.started_at).toISOString(),
      overlapScore: Number(best.score.toFixed(4)),
      text: best.row.text.replace(/\s+/gu, " ").trim().slice(0, 500),
    },
  };
}

function main(): void {
  const observationsDir = option("--observations", DEFAULT_OBSERVATIONS);
  const sessionsDb = option("--sessions-db", DEFAULT_SESSIONS_DB);
  const exampleCount = Math.max(0, Math.floor(numberOption("--examples", 5)));
  if (!existsSync(observationsDir)) throw new Error(`observation directory missing: ${observationsDir}`);
  if (!existsSync(sessionsDb)) throw new Error(`session database missing: ${sessionsDb}`);

  const loaded = loadPages(observationsDir);
  const db = new Database(sessionsDb, { readonly: true, strict: true });
  db.exec("PRAGMA query_only = ON");
  const mappings = loaded.pages.map((page) => mapPage(db, page));
  const pageByPath = new Map(loaded.pages.map((page) => [page.path, page]));
  const examples = mappings
    .filter((mapping) => mapping.confidence === "high" && mapping.kind === "conversation-window")
    .sort((a, b) => (b.window.to ?? 0) - (a.window.to ?? 0))
    .slice(0, exampleCount)
    .map((mapping) => addEvidence(db, pageByPath.get(mapping.page)!, mapping));

  const counts = (key: "kind" | "confidence") => Object.fromEntries(
    [...new Set(mappings.map((mapping) => mapping[key]))]
      .sort()
      .map((value) => [value, mappings.filter((mapping) => mapping[key] === value).length]),
  );
  const mapped = mappings.filter((mapping) => mapping.confidence !== "none").length;
  const transcriptEligible = mappings.filter((mapping) =>
    mapping.kind === "conversation-window" || mapping.kind === "conversation" || mapping.kind === "capture-run" || mapping.kind === "unmapped",
  ).length;
  const mappedEligible = mappings.filter((mapping) => mapping.confidence !== "none" && mapping.kind !== "operational-run" && mapping.kind !== "synthetic").length;

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    readOnly: true,
    inputs: { observationsDir, sessionsDb },
    population: {
      observationPages: mappings.length,
      malformedPages: loaded.malformed.length,
      mappedPages: mapped,
      mappedFraction: mappings.length ? mapped / mappings.length : 0,
      transcriptEligiblePages: transcriptEligible,
      mappedTranscriptEligiblePages: mappedEligible,
      mappedTranscriptEligibleFraction: transcriptEligible ? mappedEligible / transcriptEligible : 0,
    },
    byKind: counts("kind"),
    byConfidence: counts("confidence"),
    malformed: loaded.malformed,
    examples,
  }, null, 2));
  db.close();
}

main();
