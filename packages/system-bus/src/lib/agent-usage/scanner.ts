import type { Dirent } from "node:fs";
import { mkdir, open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { emitOtelEvent } from "../../observability/emit";
import type { OtelEventInput } from "../../observability/otel-event";
import {
  type AgentRuntimeName,
  type AgentUsageCaptureConfig,
  resolveAgentUsageCaptureConfig,
} from "./config";
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

export type AgentUsageFileState = {
  offset: number;
  mtimeMs: number;
  skipped?: {
    reason: "unread-remainder-limit";
    bytes: number;
    atMs: number;
  };
};

export type AgentUsageScanState = {
  files: Record<string, AgentUsageFileState>;
  lastScanMs: number;
};

export type RuntimeScanSummary = {
  scannedFiles: number;
  parsedEvents: number;
  emittedEvents: number;
  skippedFiles: number;
  droppedFiles: number;
  oversizedFiles: number;
  skippedBytes: number;
};

export type AgentUsageScanSummary = RuntimeScanSummary & {
  byRuntime: Partial<Record<AgentRuntimeName, RuntimeScanSummary>>;
};

export type AgentUsageScanLimits = {
  readChunkBytes: number;
  maxUnreadBytesPerFile: number;
  maxReadBytesPerScan: number;
};

export type AgentUsageScanOptions = {
  config?: AgentUsageCaptureConfig;
  /** Override transcript roots per runtime (tests). */
  roots?: Partial<Record<AgentRuntimeName, string>>;
  /** Override parsers per runtime (tests). */
  parsers?: Partial<Record<AgentRuntimeName, AgentUsageParser>>;
  /** Override bounded-reader limits (tests). */
  limits?: Partial<AgentUsageScanLimits>;
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
  let entries: Dirent[];
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
type LineConsumer = (line: CompletedLine) => boolean;

type ReadNewLinesResult = {
  start: number;
  fileSize: number;
  mtimeMs: number;
  bytesRead: number;
  consumedOffset: number;
  reachedEnd: boolean;
  skippedUnreadBytes?: number;
};

const DEFAULT_SCAN_LIMITS: AgentUsageScanLimits = {
  readChunkBytes: 1024 * 1024,
  maxUnreadBytesPerFile: 64 * 1024 * 1024,
  maxReadBytesPerScan: 64 * 1024 * 1024,
};

function resolveScanLimits(overrides: Partial<AgentUsageScanLimits> = {}): AgentUsageScanLimits {
  const positiveInteger = (value: number | undefined, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.max(1, Math.floor(value))
      : fallback;
  return {
    readChunkBytes: positiveInteger(overrides.readChunkBytes, DEFAULT_SCAN_LIMITS.readChunkBytes),
    maxUnreadBytesPerFile: positiveInteger(
      overrides.maxUnreadBytesPerFile,
      DEFAULT_SCAN_LIMITS.maxUnreadBytesPerFile,
    ),
    maxReadBytesPerScan: positiveInteger(
      overrides.maxReadBytesPerScan,
      DEFAULT_SCAN_LIMITS.maxReadBytesPerScan,
    ),
  };
}

function joinLineParts(parts: Buffer[], length: number): Buffer {
  if (parts.length === 0) return Buffer.alloc(0);
  if (parts.length === 1) return parts[0]!;
  return Buffer.concat(parts, length);
}

/**
 * Read in bounded chunks, consuming complete lines as they arrive. A single
 * line may span chunks, but its parts are joined only once. Huge unread tails
 * are advanced and marked rather than allocating or retrying the same bytes.
 */
async function readNewLines(
  path: string,
  offset: number,
  maxBytesToRead: number,
  limits: AgentUsageScanLimits,
  consume: LineConsumer,
): Promise<ReadNewLinesResult> {
  const fileStat = await stat(path);
  const start = fileStat.size < offset ? 0 : offset;
  const unreadBytes = fileStat.size - start;
  if (unreadBytes > limits.maxUnreadBytesPerFile) {
    return {
      start,
      fileSize: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      bytesRead: 0,
      consumedOffset: fileStat.size,
      reachedEnd: true,
      skippedUnreadBytes: unreadBytes,
    };
  }
  if (unreadBytes === 0) {
    return {
      start,
      fileSize: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      bytesRead: 0,
      consumedOffset: start,
      reachedEnd: true,
    };
  }

  const readLimit = Math.min(unreadBytes, maxBytesToRead);
  let bytesRead = 0;
  let consumedOffset = start;
  let stoppedEarly = false;
  let pendingParts: Buffer[] = [];
  let pendingLength = 0;
  const handle = await open(path, "r");
  try {
    while (bytesRead < readLimit) {
      const chunkLength = Math.min(limits.readChunkBytes, readLimit - bytesRead);
      const buffer = Buffer.allocUnsafe(chunkLength);
      const result = await handle.read(buffer, 0, chunkLength, start + bytesRead);
      if (result.bytesRead === 0) break;

      const chunk = buffer.subarray(0, result.bytesRead);
      const chunkStart = start + bytesRead;
      bytesRead += result.bytesRead;
      let cursor = 0;

      while (cursor < chunk.length) {
        const newlineIndex = chunk.indexOf(0x0a, cursor);
        const lineEnd = newlineIndex === -1 ? chunk.length : newlineIndex;
        const segment = chunk.subarray(cursor, lineEnd);
        if (segment.length > 0) {
          pendingParts.push(segment);
          pendingLength += segment.length;
        }
        if (newlineIndex === -1) break;

        const endOffset = chunkStart + newlineIndex + 1;
        const accepted = consume({
          text: joinLineParts(pendingParts, pendingLength).toString("utf8"),
          endOffset,
        });
        if (!accepted) {
          stoppedEarly = true;
          break;
        }

        consumedOffset = endOffset;
        pendingParts = [];
        pendingLength = 0;
        cursor = newlineIndex + 1;
      }
      if (stoppedEarly) break;
    }
  } finally {
    await handle.close();
  }

  const reachedEnd = !stoppedEarly && bytesRead >= unreadBytes;
  if (reachedEnd && pendingLength > 0) {
    const tail = joinLineParts(pendingParts, pendingLength).toString("utf8");
    const trimmed = tail.trim();
    if (trimmed.startsWith("{")) {
      try {
        JSON.parse(trimmed);
        const endOffset = start + bytesRead;
        if (consume({ text: tail, endOffset })) consumedOffset = endOffset;
        else stoppedEarly = true;
      } catch {
        // partial write in progress — leave for the next scan
      }
    }
  }

  return {
    start,
    fileSize: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    bytesRead,
    consumedOffset,
    reachedEnd: reachedEnd && !stoppedEarly,
  };
}

function emptyRuntimeSummary(): RuntimeScanSummary {
  return {
    scannedFiles: 0,
    parsedEvents: 0,
    emittedEvents: 0,
    skippedFiles: 0,
    droppedFiles: 0,
    oversizedFiles: 0,
    skippedBytes: 0,
  };
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

export async function scanAgentUsage(
  options: AgentUsageScanOptions = {},
): Promise<AgentUsageScanSummary> {
  const config = options.config ?? resolveAgentUsageCaptureConfig();
  const emit = options.emit ?? emitOtelEvent;
  const now = options.now ?? Date.now();
  const firstRunCutoff = now - config.lookbackHours * 60 * 60 * 1000;
  const limits = resolveScanLimits(options.limits);

  const state = await readState(config.statePath);
  const summary: AgentUsageScanSummary = { ...emptyRuntimeSummary(), byRuntime: {} };
  let eventBudget = config.maxEventsPerScan;
  let fileBudget = config.maxFilesPerScan;
  let readBudget = limits.maxReadBytesPerScan;

  for (const runtime of config.agents) {
    const runtimeSummary = emptyRuntimeSummary();
    summary.byRuntime[runtime] = runtimeSummary;
    const parser = options.parsers?.[runtime] ?? PARSERS[runtime];
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
      if (eventBudget <= 0 || readBudget <= 0) {
        // Remaining selected files carry to the next bounded scan.
        runtimeSummary.droppedFiles += selected.length - index;
        break;
      }

      const previousFileState = state.files[candidate.path];
      const storedOffset = previousFileState?.offset ?? 0;
      const context = { path: candidate.path };
      const parserState = parser.createState(context);
      const events: AgentUsageEvent[] = [];
      let readResult: ReadNewLinesResult;
      try {
        readResult = await readNewLines(
          candidate.path,
          storedOffset,
          readBudget,
          limits,
          (line) => {
            const parsed = parser.parseLine(line.text, context, parserState);
            runtimeSummary.parsedEvents += parsed.length;
            if (parsed.length > eventBudget - events.length) return false;
            events.push(...parsed);
            return true;
          },
        );
      } catch {
        runtimeSummary.skippedFiles += 1;
        continue;
      }
      runtimeSummary.scannedFiles += 1;
      readBudget -= readResult.bytesRead;

      if (readResult.skippedUnreadBytes !== undefined) {
        runtimeSummary.skippedFiles += 1;
        runtimeSummary.oversizedFiles += 1;
        runtimeSummary.skippedBytes += readResult.skippedUnreadBytes;
        state.files[candidate.path] = {
          offset: readResult.fileSize,
          mtimeMs: readResult.mtimeMs,
          skipped: {
            reason: "unread-remainder-limit",
            bytes: readResult.skippedUnreadBytes,
            atMs: now,
          },
        };
        continue;
      }

      for (const event of events) await emit(toOtelInput(event));
      runtimeSummary.emittedEvents += events.length;
      eventBudget -= events.length;

      const priorSkip = previousFileState?.skipped;
      state.files[candidate.path] = {
        offset: readResult.consumedOffset,
        // A partially consumed file stays eligible for the next scan.
        mtimeMs: readResult.reachedEnd ? readResult.mtimeMs : readResult.mtimeMs - 1,
        ...(priorSkip ? { skipped: priorSkip } : {}),
      };
    }

    summary.scannedFiles += runtimeSummary.scannedFiles;
    summary.parsedEvents += runtimeSummary.parsedEvents;
    summary.emittedEvents += runtimeSummary.emittedEvents;
    summary.skippedFiles += runtimeSummary.skippedFiles;
    summary.droppedFiles += runtimeSummary.droppedFiles;
    summary.oversizedFiles += runtimeSummary.oversizedFiles;
    summary.skippedBytes += runtimeSummary.skippedBytes;
  }

  state.lastScanMs = now;
  await writeState(config.statePath, state);
  return summary;
}
