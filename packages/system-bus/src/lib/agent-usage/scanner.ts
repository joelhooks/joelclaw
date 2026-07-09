import { mkdir, open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { emitOtelEvent } from "../../observability/emit";
import type { OtelEventInput } from "../../observability/otel-event";
import { type AgentRuntimeName, type AgentUsageCaptureConfig, resolveAgentUsageCaptureConfig } from "./config";
import * as claudeParser from "./parsers/claude";
import * as codexParser from "./parsers/codex";
import * as cursorParser from "./parsers/cursor";
import * as piParser from "./parsers/pi";
import type { AgentUsageEvent, AgentUsageParser } from "./types";

const PARSERS: Record<AgentRuntimeName, AgentUsageParser> = {
  pi: piParser,
  claude: claudeParser,
  codex: codexParser,
  cursor: cursorParser,
};

export type AgentUsageScanState = {
  files: Record<string, { offset: number; mtimeMs: number }>;
  lastScanMs: number;
};

export type RuntimeScanSummary = {
  scannedFiles: number;
  parsedEvents: number;
  emittedEvents: number;
  skippedFiles: number;
  droppedFiles: number;
};

export type AgentUsageScanSummary = RuntimeScanSummary & {
  byRuntime: Partial<Record<AgentRuntimeName, RuntimeScanSummary>>;
};

export type AgentUsageScanOptions = {
  config?: AgentUsageCaptureConfig;
  /** Override transcript roots per runtime (tests). */
  roots?: Partial<Record<AgentRuntimeName, string>>;
  /** Override the OTEL emitter (tests). */
  emit?: (input: OtelEventInput) => Promise<unknown>;
  now?: number;
};

async function readState(statePath: string): Promise<AgentUsageScanState> {
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const state = parsed as Partial<AgentUsageScanState>;
      return {
        files: state.files && typeof state.files === "object" ? state.files : {},
        lastScanMs: typeof state.lastScanMs === "number" ? state.lastScanMs : 0,
      };
    }
  } catch {
    // missing or corrupt state — treat as first run
  }
  return { files: {}, lastScanMs: 0 };
}

async function writeState(statePath: string, state: AgentUsageScanState): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, JSON.stringify(state), "utf8");
  await rename(tempPath, statePath);
}

async function collectJsonlFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    try {
      if (entry.isDirectory()) {
        files.push(...(await collectJsonlFiles(fullPath)));
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(fullPath);
      }
    } catch {
      // unreadable entry — skip
    }
  }
  return files;
}

type CompletedLine = { text: string; endOffset: number };

/**
 * Read bytes past `offset` and split into complete lines with absolute byte
 * offsets. A trailing unterminated line is only consumed if it parses as JSON
 * (a writer may be mid-line); otherwise it is left for the next scan.
 */
async function readNewLines(path: string, offset: number): Promise<{ lines: CompletedLine[]; start: number }> {
  const fileStat = await stat(path);
  const start = fileStat.size < offset ? 0 : offset;
  if (fileStat.size <= start) return { lines: [], start };

  const handle = await open(path, "r");
  let buffer: Buffer;
  try {
    const length = fileStat.size - start;
    buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
  } finally {
    await handle.close();
  }

  const lines: CompletedLine[] = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    const newlineIndex = buffer.indexOf(0x0a, cursor);
    if (newlineIndex === -1) {
      const tail = buffer.subarray(cursor).toString("utf8");
      const trimmed = tail.trim();
      if (trimmed.startsWith("{")) {
        try {
          JSON.parse(trimmed);
          lines.push({ text: tail, endOffset: start + buffer.length });
        } catch {
          // partial write in progress — leave for next scan
        }
      }
      break;
    }
    lines.push({
      text: buffer.subarray(cursor, newlineIndex).toString("utf8"),
      endOffset: start + newlineIndex + 1,
    });
    cursor = newlineIndex + 1;
  }
  return { lines, start };
}

function emptyRuntimeSummary(): RuntimeScanSummary {
  return { scannedFiles: 0, parsedEvents: 0, emittedEvents: 0, skippedFiles: 0, droppedFiles: 0 };
}

function toOtelInput(event: AgentUsageEvent): OtelEventInput {
  return {
    id: event.id,
    timestamp: event.timestampMs,
    sessionId: event.sessionId,
    level: "info",
    source: "agent-usage",
    component: `agent-usage.${event.runtime}`,
    action: "agent_usage.turn",
    success: true,
    metadata: {
      runtime: event.runtime,
      model: event.model,
      provider: event.provider,
      usage: event.usage,
      transcriptPath: event.transcriptPath,
    },
  };
}

export async function scanAgentUsage(options: AgentUsageScanOptions = {}): Promise<AgentUsageScanSummary> {
  const config = options.config ?? resolveAgentUsageCaptureConfig();
  const emit = options.emit ?? emitOtelEvent;
  const now = options.now ?? Date.now();
  const firstRunCutoff = now - config.lookbackHours * 60 * 60 * 1000;

  const state = await readState(config.statePath);
  const summary: AgentUsageScanSummary = { ...emptyRuntimeSummary(), byRuntime: {} };
  let eventBudget = config.maxEventsPerScan;
  let fileBudget = config.maxFilesPerScan;

  for (const runtime of config.agents) {
    const runtimeSummary = emptyRuntimeSummary();
    summary.byRuntime[runtime] = runtimeSummary;
    const parser = PARSERS[runtime];
    const root = options.roots?.[runtime] ?? parser.transcriptRoot();

    const candidates: { path: string; mtimeMs: number }[] = [];
    for (const path of await collectJsonlFiles(root)) {
      try {
        const fileStat = await stat(path);
        const threshold = state.files[path]?.mtimeMs ?? firstRunCutoff;
        if (fileStat.mtimeMs > threshold) {
          candidates.push({ path, mtimeMs: fileStat.mtimeMs });
        }
      } catch {
        runtimeSummary.skippedFiles += 1;
      }
    }

    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const selected = candidates.slice(0, Math.max(fileBudget, 0));
    runtimeSummary.droppedFiles += candidates.length - selected.length;
    fileBudget -= selected.length;

    for (const [index, candidate] of selected.entries()) {
      if (eventBudget <= 0) {
        // Event budget exhausted — remaining selected files carry to next scan.
        runtimeSummary.droppedFiles += selected.length - index;
        break;
      }

      const storedOffset = state.files[candidate.path]?.offset ?? 0;
      let lines: CompletedLine[];
      let start: number;
      try {
        ({ lines, start } = await readNewLines(candidate.path, storedOffset));
      } catch {
        runtimeSummary.skippedFiles += 1;
        continue;
      }
      runtimeSummary.scannedFiles += 1;

      const allEvents = parser.parseTranscriptLines(
        lines.map((line) => line.text),
        { path: candidate.path }
      );
      runtimeSummary.parsedEvents += allEvents.length;

      let events = allEvents;
      let consumedOffset = lines.length > 0 ? (lines[lines.length - 1]?.endOffset ?? start) : start;

      if (allEvents.length > eventBudget) {
        // Over budget: find the longest line prefix whose parse fits, advance
        // the offset only past what was emitted, and carry the rest next scan.
        let prefixLength = 0;
        let prefixEvents: AgentUsageEvent[] = [];
        for (let i = 1; i <= lines.length; i += 1) {
          const parsedPrefix = parser.parseTranscriptLines(
            lines.slice(0, i).map((line) => line.text),
            { path: candidate.path }
          );
          if (parsedPrefix.length > eventBudget) break;
          prefixLength = i;
          prefixEvents = parsedPrefix;
        }
        events = prefixEvents;
        consumedOffset = prefixLength > 0 ? (lines[prefixLength - 1]?.endOffset ?? start) : start;
      }

      for (const event of events) {
        await emit(toOtelInput(event));
      }
      runtimeSummary.emittedEvents += events.length;
      eventBudget -= events.length;

      const fullyConsumed = events.length === allEvents.length;
      state.files[candidate.path] = {
        offset: consumedOffset,
        // A partially consumed file stays eligible: stored mtime just below
        // the file's mtime keeps `mtime > threshold` true next scan.
        mtimeMs: fullyConsumed ? candidate.mtimeMs : candidate.mtimeMs - 1,
      };
    }

    summary.scannedFiles += runtimeSummary.scannedFiles;
    summary.parsedEvents += runtimeSummary.parsedEvents;
    summary.emittedEvents += runtimeSummary.emittedEvents;
    summary.skippedFiles += runtimeSummary.skippedFiles;
    summary.droppedFiles += runtimeSummary.droppedFiles;
  }

  state.lastScanMs = now;
  await writeState(config.statePath, state);
  return summary;
}
