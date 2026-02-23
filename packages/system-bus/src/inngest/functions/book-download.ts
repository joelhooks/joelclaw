import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { NonRetriableError } from "inngest";
import { parsePiJsonAssistant, traceLlmGeneration } from "../../lib/langfuse";
import { MODEL, assertAllowedModel } from "../../lib/models";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";
import { pushGatewayEvent } from "./agent-loop/utils";

const HOME_DIR = process.env.HOME || "/Users/joel";
const DEFAULT_OUTPUT_DIR = `${HOME_DIR}/clawd/data/pdf-brain/incoming`;
const DEFAULT_SECRET_PATH = `${HOME_DIR}/.config/annas-archive/secret.txt`;
const AA_SECRET_TTL = process.env.JOELCLAW_AA_SECRET_TTL?.trim() || "4h";
const BOOK_SEARCH_TIMEOUT_MS = Math.max(
  10_000,
  Number.parseInt(process.env.JOELCLAW_BOOK_SEARCH_TIMEOUT_MS ?? "45000", 10)
);
const BOOK_SELECTION_TIMEOUT_MS = Math.max(
  10_000,
  Number.parseInt(process.env.JOELCLAW_BOOK_SELECTION_TIMEOUT_MS ?? "60000", 10)
);
const BOOK_DOWNLOAD_TIMEOUT_MS = Math.max(
  60_000,
  Number.parseInt(process.env.JOELCLAW_BOOK_DOWNLOAD_TIMEOUT_MS ?? "900000", 10)
);
const BOOK_SELECTION_SYSTEM_PROMPT = `You select the best Anna's Archive MD5 candidate for a requested book.

Rules:
- Prefer exact title/author matches.
- Respect requested format when provided (e.g. pdf).
- Prefer clean technical editions over scans when plausible.
- If multiple are close, pick the one most likely to be the canonical technical edition.
- Return ONLY valid JSON.

Schema:
{"md5":"32-char lowercase hex","reason":"one short sentence","confidence":0.0-1.0}`;

type ProcessResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

type SearchCandidate = {
  md5: string;
  title: string;
  format?: string;
  size?: string;
  line: string;
};

type SelectedBook = {
  md5: string;
  reason: string;
  selectedBy: "provided" | "inference" | "fallback";
  candidate?: SearchCandidate;
  confidence?: number;
  model?: string;
};

type OutputEntry = {
  path: string;
  mtimeMs: number;
};

function normalizeMd5(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return /^[a-f0-9]{32}$/u.test(normalized) ? normalized : null;
}

function normalizeFormat(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  return normalized;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/gu, "");
}

function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return Promise.resolve("");
  return new Response(stream).text();
}

async function runProcess(
  cmd: string[],
  timeoutMs: number,
  stdinText?: string
): Promise<ProcessResult> {
  const proc = Bun.spawn(cmd, {
    env: { ...process.env, TERM: "dumb" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  if (proc.stdin) {
    if (stdinText) proc.stdin.write(stdinText);
    proc.stdin.end();
  }

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // no-op
    }
  }, timeoutMs);

  const [stdout, stderr, exitCode] = await Promise.all([
    readStream(proc.stdout),
    readStream(proc.stderr),
    proc.exited.catch(() => -1),
  ]);
  clearTimeout(timeout);

  return {
    exitCode,
    stdout,
    stderr,
    timedOut,
  };
}

function parseSearchCandidates(raw: string): SearchCandidate[] {
  const lines = stripAnsi(raw).split(/\r?\n/gu);
  const byMd5 = new Map<string, SearchCandidate>();

  for (const line of lines) {
    const match = line.match(/^\s*([a-f0-9]{32})\b\s*(.*)$/iu);
    if (!match) continue;
    const md5 = (match[1] ?? "").toLowerCase();
    if (!md5 || byMd5.has(md5)) continue;

    const rest = (match[2] ?? "").trim();
    const formatMatch = rest.match(/\b(pdf|epub|mobi|djvu|azw3)\b/iu);
    const sizeMatch = rest.match(/\b\d+(?:\.\d+)?\s*[KMG]?B\b/iu);
    const title = rest
      .replace(/\b(pdf|epub|mobi|djvu|azw3)\b/iu, "")
      .replace(/\b\d+(?:\.\d+)?\s*[KMG]?B\b/iu, "")
      .replace(/\s{2,}/gu, " ")
      .trim();

    byMd5.set(md5, {
      md5,
      format: formatMatch?.[1]?.toLowerCase(),
      size: sizeMatch?.[0],
      title: title || "Untitled",
      line: line.trim(),
    });
  }

  return [...byMd5.values()];
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // continue
  }

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/iu);
  if (fenceMatch?.[1]) {
    try {
      const parsed = JSON.parse(fenceMatch[1]) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // continue
    }
  }

  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  if (objectStart !== -1 && objectEnd > objectStart) {
    try {
      const parsed = JSON.parse(trimmed.slice(objectStart, objectEnd + 1)) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // continue
    }
  }

  return null;
}

function parseInferenceSelection(raw: string): {
  md5: string | null;
  reason: string;
  confidence?: number;
} {
  const parsed = parseJsonObject(raw);
  if (parsed) {
    const jsonMd5 = normalizeMd5(typeof parsed.md5 === "string" ? parsed.md5 : undefined);
    const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
    const confidenceRaw = typeof parsed.confidence === "number" ? parsed.confidence : undefined;
    const confidence = Number.isFinite(confidenceRaw) ? confidenceRaw : undefined;
    if (jsonMd5) {
      return {
        md5: jsonMd5,
        reason: reason || "Selected by inference.",
        confidence,
      };
    }
  }

  const textMd5 = normalizeMd5(raw.match(/\b([a-f0-9]{32})\b/iu)?.[1]);
  if (textMd5) {
    return {
      md5: textMd5,
      reason: "Selected by inference from plain-text response.",
    };
  }

  return {
    md5: null,
    reason: "Inference response did not include a valid MD5.",
  };
}

function resolveSelectionModel(): string {
  const model = process.env.JOELCLAW_BOOK_SELECTION_MODEL?.trim() || MODEL.SONNET;
  assertAllowedModel(model);
  return model;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveAABookBinary(): Promise<string> {
  const envPath = process.env.JOELCLAW_AA_BOOK_BIN?.trim();
  const candidates = [
    envPath,
    "aa-book",
    `${HOME_DIR}/Code/aa-download/bin/aa-book`,
    `${HOME_DIR}/Code/joelhooks/aa-download/bin/aa-book`,
  ].filter((value): value is string => Boolean(value && value.length > 0));

  for (const candidate of candidates) {
    if (candidate === "aa-book") {
      const probe = await runProcess(["sh", "-lc", "command -v aa-book"], 3_000);
      if (probe.exitCode === 0) {
        const resolved = probe.stdout.trim().split(/\r?\n/gu)[0]?.trim();
        if (resolved) return resolved;
      }
      continue;
    }

    if (await isExecutable(candidate)) return candidate;
  }

  throw new NonRetriableError(
    "aa-book binary not found. Set JOELCLAW_AA_BOOK_BIN or install aa-book in PATH."
  );
}

async function ensureAnnasArchiveSecret(secretPath: string): Promise<{
  status: "existing" | "leased";
  path: string;
}> {
  try {
    const current = (await readFile(secretPath, "utf8")).trim();
    if (current.length > 0) {
      return { status: "existing", path: secretPath };
    }
  } catch {
    // continue to lease
  }

  const leaseRaw = await runProcess(
    ["secrets", "lease", "annas_archive_key", "--ttl", AA_SECRET_TTL, "--raw"],
    10_000
  );
  let leased = leaseRaw.exitCode === 0 ? leaseRaw.stdout.trim() : "";

  if (!leased) {
    const leaseFallback = await runProcess(
      ["secrets", "lease", "annas_archive_key", "--ttl", AA_SECRET_TTL],
      10_000
    );
    if (leaseFallback.exitCode === 0) leased = leaseFallback.stdout.trim();
  }

  if (!leased) {
    throw new NonRetriableError(
      "Unable to lease annas_archive_key. Run: secrets add annas_archive_key --value <key>"
    );
  }

  await mkdir(dirname(secretPath), { recursive: true });
  await writeFile(secretPath, `${leased}\n`, { mode: 0o600 });
  try {
    await chmod(secretPath, 0o600);
  } catch {
    // no-op
  }

  return { status: "leased", path: secretPath };
}

async function listOutputEntries(outputDir: string): Promise<OutputEntry[]> {
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(outputDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: OutputEntry[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(outputDir, entry.name);
    try {
      const details = await stat(path);
      files.push({ path, mtimeMs: details.mtimeMs });
    } catch {
      // skip entries that disappear
    }
  }

  return files;
}

function extractExistingPathFromOutput(raw: string): string | null {
  const cleaned = stripAnsi(raw);
  const pathMatches = cleaned.match(/\/[^\s"']+\.(pdf|epub|mobi|azw3|djvu|md|txt)/giu) ?? [];
  for (const match of pathMatches.reverse()) {
    const candidate = match.trim();
    if (candidate.startsWith("/")) return candidate;
  }
  return null;
}

async function resolveDownloadedPath(
  rawOutput: string,
  outputDir: string,
  beforeEntries: OutputEntry[]
): Promise<string> {
  const existingFromOutput = extractExistingPathFromOutput(rawOutput);
  if (existingFromOutput) {
    try {
      const details = await stat(existingFromOutput);
      if (details.isFile()) return existingFromOutput;
    } catch {
      // continue with directory diff
    }
  }

  const afterEntries = await listOutputEntries(outputDir);
  const beforeMap = new Map(beforeEntries.map((entry) => [entry.path, entry.mtimeMs]));
  const newEntries = afterEntries
    .filter((entry) => {
      const prev = beforeMap.get(entry.path);
      if (prev == null) return true;
      return entry.mtimeMs > prev + 1;
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const newestNewEntry = newEntries[0];
  if (newestNewEntry) return newestNewEntry.path;

  const newest = [...afterEntries].sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  if (newest) return newest.path;

  throw new Error(`Unable to resolve downloaded file path in ${outputDir}`);
}

function inferTitle(candidateTitle: string | undefined, fallbackPath: string): string {
  if (candidateTitle && candidateTitle.trim().length > 0) return candidateTitle.trim();
  const stem = basename(fallbackPath, extname(fallbackPath)).trim();
  return stem || "Untitled Book";
}

function compactTags(input: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const value of input) {
    if (!value) continue;
    const normalized = value.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    tags.push(normalized);
  }
  return tags;
}

async function chooseBookCandidate(input: {
  query: string;
  requestedFormat?: string;
  candidates: SearchCandidate[];
}): Promise<{
  md5: string | null;
  reason: string;
  confidence?: number;
  model?: string;
  provider?: string;
}> {
  const model = resolveSelectionModel();
  const candidateLines = input.candidates
    .slice(0, 20)
    .map((candidate, index) => {
      const fields = [
        `${index + 1}. md5=${candidate.md5}`,
        `format=${candidate.format ?? "unknown"}`,
        `size=${candidate.size ?? "unknown"}`,
        `title=${candidate.title || "Untitled"}`,
      ];
      return fields.join(" | ");
    })
    .join("\n");

  const userPrompt = [
    `Query: ${input.query}`,
    `Requested format: ${input.requestedFormat ?? "any"}`,
    "",
    "Candidates:",
    candidateLines,
    "",
    "Return only valid JSON with md5/reason/confidence.",
  ].join("\n");

  const startedAt = Date.now();
  const proc = await runProcess(
    [
      "pi",
      "-p",
      "--no-session",
      "--no-extensions",
      "--mode",
      "json",
      "--model",
      model,
      "--system-prompt",
      BOOK_SELECTION_SYSTEM_PROMPT,
      userPrompt,
    ],
    BOOK_SELECTION_TIMEOUT_MS
  );
  const stdoutRaw = proc.stdout;
  const parsedPi = parsePiJsonAssistant(stdoutRaw);
  const assistantText = parsedPi?.text ?? stdoutRaw;
  const selection = parseInferenceSelection(assistantText);

  await traceLlmGeneration({
    traceName: "joelclaw.book-download",
    generationName: "book.select-md5",
    component: "book-download",
    action: "book.select-md5",
    input: {
      query: input.query,
      requestedFormat: input.requestedFormat,
      candidateCount: input.candidates.length,
      candidates: input.candidates.slice(0, 20).map((candidate) => ({
        md5: candidate.md5,
        title: candidate.title,
        format: candidate.format,
        size: candidate.size,
      })),
    },
    output: {
      response: assistantText.slice(0, 3_000),
      stderr: proc.stderr.trim().slice(0, 800),
      parsedMd5: selection.md5,
      reason: selection.reason,
      timedOut: proc.timedOut,
    },
    provider: parsedPi?.provider,
    model: parsedPi?.model ?? model,
    usage: parsedPi?.usage,
    durationMs: Date.now() - startedAt,
    error:
      proc.exitCode !== 0 && !assistantText.trim()
        ? `pi selection failed (${proc.exitCode}): ${proc.stderr.trim()}`
        : undefined,
    metadata: {
      query: input.query,
      candidateCount: input.candidates.length,
      timedOut: proc.timedOut,
    },
  });

  if (proc.timedOut) {
    return {
      md5: null,
      reason: "Inference timed out; fallback candidate used.",
      model,
      provider: parsedPi?.provider,
    };
  }

  if (proc.exitCode !== 0 && !assistantText.trim()) {
    return {
      md5: null,
      reason: `Inference failed with exit ${proc.exitCode}; fallback candidate used.`,
      model,
      provider: parsedPi?.provider,
    };
  }

  return {
    md5: selection.md5,
    reason: selection.reason,
    confidence: selection.confidence,
    model: parsedPi?.model ?? model,
    provider: parsedPi?.provider,
  };
}

export const bookDownload = inngest.createFunction(
  {
    id: "book-download",
    name: "Book Download -> Docs Ingest",
    retries: 1,
    concurrency: { limit: 1 },
  },
  { event: "pipeline/book.download" },
  async ({ event, step }) => {
    const requestedMd5 = normalizeMd5(event.data.md5);
    const query = (event.data.query ?? "").trim();
    const requestedFormat = normalizeFormat(event.data.format);
    const reason = (event.data.reason ?? "").trim() || "book acquisition via pipeline/book.download";
    const outputDir = (event.data.outputDir ?? "").trim() || DEFAULT_OUTPUT_DIR;
    const outputPath = outputDir.startsWith("/") ? outputDir : join(HOME_DIR, outputDir);
    const configuredSecretPath = (process.env.JOELCLAW_AA_SECRET_PATH ?? "").trim();
    const secretPath = configuredSecretPath || DEFAULT_SECRET_PATH;

    if (!query && !requestedMd5) {
      throw new NonRetriableError("pipeline/book.download requires `query` or `md5`.");
    }

    const baseTags = compactTags([
      "aa-book",
      "book",
      requestedFormat ? `format:${requestedFormat}` : undefined,
      ...(event.data.tags ?? []),
    ]);

    await step.run("otel-book-download-started", async () => {
      await emitOtelEvent({
        level: "info",
        source: "worker",
        component: "book-download",
        action: "book.download.requested",
        success: true,
        metadata: {
          query: query || null,
          requestedMd5,
          requestedFormat: requestedFormat ?? null,
          outputDir: outputPath,
          tags: baseTags,
          reason,
        },
      });
    });

    try {
      const aaBookBin = await step.run("resolve-aa-book-binary", async () => {
        return resolveAABookBinary();
      });

      await step.run("ensure-output-dir", async () => {
        await mkdir(outputPath, { recursive: true });
      });

      const secretStatus = await step.run("ensure-aa-secret", async () => {
        return ensureAnnasArchiveSecret(secretPath);
      });

      await step.run("otel-aa-secret-ready", async () => {
        await emitOtelEvent({
          level: "info",
          source: "worker",
          component: "book-download",
          action: "book.auth.ready",
          success: true,
          metadata: {
            secretStatus: secretStatus.status,
            secretPath: secretStatus.path,
          },
        });
      });

      const selected: SelectedBook = requestedMd5
        ? {
            md5: requestedMd5,
            reason: "Provided by event payload.",
            selectedBy: "provided",
          }
        : await step.run("search-and-select-md5", async () => {
            const searchCmd = requestedFormat
              ? [aaBookBin, "search", query, requestedFormat]
              : [aaBookBin, "search", query];
            const searchResult = await runProcess(searchCmd, BOOK_SEARCH_TIMEOUT_MS);
            const combinedSearchOutput = `${searchResult.stdout}\n${searchResult.stderr}`;

            if (searchResult.timedOut) {
              throw new Error(`aa-book search timed out after ${BOOK_SEARCH_TIMEOUT_MS}ms`);
            }

            if (searchResult.exitCode !== 0 && !combinedSearchOutput.trim()) {
              throw new Error(
                `aa-book search failed (exit ${searchResult.exitCode}): ${searchResult.stderr.trim()}`
              );
            }

            const candidates = parseSearchCandidates(combinedSearchOutput);
            if (candidates.length === 0) {
              throw new NonRetriableError(
                `No candidate MD5s found for query "${query}"${requestedFormat ? ` (${requestedFormat})` : ""}.`
              );
            }

            await emitOtelEvent({
              level: "info",
              source: "worker",
              component: "book-download",
              action: "book.search.completed",
              success: true,
              metadata: {
                query,
                requestedFormat: requestedFormat ?? null,
                candidateCount: candidates.length,
                topCandidates: candidates.slice(0, 5).map((candidate) => ({
                  md5: candidate.md5,
                  title: candidate.title,
                  format: candidate.format,
                  size: candidate.size,
                })),
              },
            });

            const inferred = await chooseBookCandidate({
              query,
              requestedFormat,
              candidates,
            });
            const inferredMd5 = normalizeMd5(inferred.md5 ?? undefined);

            if (inferredMd5) {
              return {
                md5: inferredMd5,
                reason: inferred.reason,
                selectedBy: "inference" as const,
                candidate: candidates.find((candidate) => candidate.md5 === inferredMd5),
                confidence: inferred.confidence,
                model: inferred.model,
              };
            }

            const fallback = candidates[0];
            if (!fallback) {
              throw new NonRetriableError(
                `No candidate MD5s found for query "${query}"${requestedFormat ? ` (${requestedFormat})` : ""}.`
              );
            }
            return {
              md5: fallback.md5,
              reason: `${inferred.reason} Falling back to first search candidate.`,
              selectedBy: "fallback" as const,
              candidate: fallback,
              model: inferred.model,
            };
          });

      await step.run("otel-selection-completed", async () => {
        await emitOtelEvent({
          level: "info",
          source: "worker",
          component: "book-download",
          action: "book.md5.selected",
          success: true,
          metadata: {
            query,
            selectedMd5: selected.md5,
            selectedBy: selected.selectedBy,
            reason: selected.reason,
            confidence: selected.confidence,
            model: selected.model,
            candidate: selected.candidate
              ? {
                  title: selected.candidate.title,
                  format: selected.candidate.format,
                  size: selected.candidate.size,
                }
              : null,
          },
        });
      });

      const downloadResult = await step.run("download-book", async () => {
        const beforeEntries = await listOutputEntries(outputPath);
        const command = [aaBookBin, "download", selected.md5, outputPath];
        const result = await runProcess(command, BOOK_DOWNLOAD_TIMEOUT_MS);
        const combinedOutput = `${result.stdout}\n${result.stderr}`;

        if (result.timedOut) {
          throw new Error(`aa-book download timed out after ${BOOK_DOWNLOAD_TIMEOUT_MS}ms`);
        }

        if (result.exitCode !== 0) {
          throw new Error(
            `aa-book download failed (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 800)}`
          );
        }

        const filePath = await resolveDownloadedPath(combinedOutput, outputPath, beforeEntries);
        const details = await stat(filePath);
        if (!details.isFile()) {
          throw new Error(`Downloaded path is not a file: ${filePath}`);
        }

        const fileFormat = extname(filePath).replace(/^\./u, "").toLowerCase() || undefined;
        return {
          filePath,
          sizeBytes: details.size,
          format: fileFormat,
          stdout: result.stdout,
          stderr: result.stderr,
        };
      });

      await step.run("otel-download-completed", async () => {
        await emitOtelEvent({
          level: "info",
          source: "worker",
          component: "book-download",
          action: "book.download.completed",
          success: true,
          metadata: {
            query: query || null,
            md5: selected.md5,
            outputPath: downloadResult.filePath,
            outputDir: outputPath,
            sizeBytes: downloadResult.sizeBytes,
            format: downloadResult.format ?? requestedFormat ?? null,
          },
        });
      });

      const resolvedTitle =
        event.data.title?.trim()
        || selected.candidate?.title?.trim()
        || inferTitle(undefined, downloadResult.filePath);
      const idempotencyKey =
        (event.data.idempotencyKey ?? "").trim()
        || `book:${selected.md5}:${basename(downloadResult.filePath).toLowerCase()}`;

      await step.sendEvent("emit-book-events", [
        {
          name: "docs/ingest.requested",
          data: {
            nasPath: downloadResult.filePath,
            title: resolvedTitle,
            tags: baseTags,
            storageCategory: event.data.storageCategory,
            sourceHost: "aa-book",
            idempotencyKey,
          },
        },
        {
          name: "pipeline/book.downloaded",
          data: {
            title: resolvedTitle,
            nasPath: downloadResult.filePath,
            query: query || undefined,
            md5: selected.md5,
            reason,
            outputDir: outputPath,
            format: downloadResult.format ?? requestedFormat ?? selected.candidate?.format,
            selectedBy: selected.selectedBy,
            tags: baseTags,
          },
        },
      ]);

      await step.run("otel-ingest-queued", async () => {
        await emitOtelEvent({
          level: "info",
          source: "worker",
          component: "book-download",
          action: "book.docs.ingest_queued",
          success: true,
          metadata: {
            md5: selected.md5,
            nasPath: downloadResult.filePath,
            idempotencyKey,
            tags: baseTags,
          },
        });
      });

      await step.run("notify-gateway", async () => {
        try {
          await pushGatewayEvent({
            type: "book.downloaded",
            source: "inngest",
            payload: {
              title: resolvedTitle,
              md5: selected.md5,
              path: downloadResult.filePath,
              selectedBy: selected.selectedBy,
            },
          });
          return { notified: true };
        } catch (error) {
          return {
            notified: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      });

      await step.run("otel-book-download-completed", async () => {
        await emitOtelEvent({
          level: "info",
          source: "worker",
          component: "book-download",
          action: "book.download.pipeline_completed",
          success: true,
          metadata: {
            query: query || null,
            md5: selected.md5,
            title: resolvedTitle,
            outputPath: downloadResult.filePath,
            selectedBy: selected.selectedBy,
          },
        });
      });

      return {
        status: "queued",
        query: query || null,
        md5: selected.md5,
        title: resolvedTitle,
        path: downloadResult.filePath,
        selectedBy: selected.selectedBy,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await step.run("otel-book-download-failed", async () => {
        await emitOtelEvent({
          level: "error",
          source: "worker",
          component: "book-download",
          action: "book.download.failed",
          success: false,
          error: message,
          metadata: {
            query: query || null,
            requestedMd5,
            requestedFormat: requestedFormat ?? null,
            outputDir: outputPath,
          },
        });
      });
      throw error;
    }
  }
);

export {
  parseSearchCandidates,
  parseInferenceSelection,
  resolveAABookBinary,
  resolveSelectionModel,
  extractExistingPathFromOutput,
};
