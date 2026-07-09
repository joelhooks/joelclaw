import type { Dirent } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { NonRetriableError } from "inngest";
import { infer } from "../../lib/inference";
import { assertAllowedModel, MODEL } from "../../lib/models";
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
const NAS_HOST = process.env.JOELCLAW_NAS_HOST?.trim() || "joel@three-body";
const NAS_BOOKS_DIR = process.env.JOELCLAW_NAS_BOOKS_DIR?.trim() || "/volume1/home/joel/books";
const NAS_BACKUP_TIMEOUT_MS = 30_000;

// aa-book's own Calibre auto-convert (bin/aa-book download_book) only handles
// epub/mobi. Anna's Archive also serves azw3 and fb2 for many ebook-only
// titles; docs-ingest only accepts pdf/md/txt, so anything else needs a
// conversion pass here before we hand the file to docs/ingest.requested.
// epub/mobi are included as a safety net in case aa-book's own conversion
// step failed and left the original file in place.
const CONVERTIBLE_EBOOK_EXTENSIONS = new Set(["azw3", "fb2", "epub", "mobi"]);
const EBOOK_CONVERT_TIMEOUT_MS = Math.max(
  30_000,
  Number.parseInt(process.env.JOELCLAW_EBOOK_CONVERT_TIMEOUT_MS ?? "180000", 10)
);

const AA_CONFIG_DIR = `${HOME_DIR}/.config/annas-archive`;
const AA_MIRRORS_CACHE_PATH = `${AA_CONFIG_DIR}/mirrors.txt`;
const AA_COOKIE_FILE_PATH = `${AA_CONFIG_DIR}/cookies.txt`;
const AA_DEFAULT_MIRRORS = ["https://annas-archive.gl", "https://annas-archive.li", "https://welib.org"];
const MD5_VERIFY_TIMEOUT_MS = Math.max(
  5_000,
  Number.parseInt(process.env.JOELCLAW_MD5_VERIFY_TIMEOUT_MS ?? "15000", 10)
);
const MAX_MD5_VERIFICATION_ATTEMPTS = Math.max(
  1,
  Number.parseInt(process.env.JOELCLAW_MD5_VERIFY_MAX_ATTEMPTS ?? "6", 10)
);
// Anna's Archive labels a `format` per md5 in search results, but the file
// behind the fast-download link can differ from that label, and some md5s
// have no fast-download tier at all (libgen-only slow links), which makes
// `aa-book download` exit 1 bare. Verify a Fast Partner Server link actually
// exists on the /md5/<hash> page before committing to a candidate.
const FAST_PARTNER_MARKERS: RegExp[] = [/fast_download\//iu, /Fast Partner Server/iu];
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

type NasBackupResult =
  | {
      backedUp: true;
      nasPath: string;
    }
  | {
      backedUp: false;
      reason: string;
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

async function resolveEbookConvertBinary(): Promise<string | null> {
  const envPath = process.env.JOELCLAW_EBOOK_CONVERT_BIN?.trim();
  const candidates = [
    envPath,
    "ebook-convert",
    // Homebrew cask install location (see joelclaw-runtime setup notes).
    "/opt/homebrew/bin/ebook-convert",
    "/usr/local/bin/ebook-convert",
  ].filter((value): value is string => Boolean(value && value.length > 0));

  for (const candidate of candidates) {
    if (candidate === "ebook-convert") {
      const probe = await runProcess(["sh", "-lc", "command -v ebook-convert"], 3_000);
      if (probe.exitCode === 0) {
        const resolved = probe.stdout.trim().split(/\r?\n/gu)[0]?.trim();
        if (resolved) return resolved;
      }
      continue;
    }

    if (await isExecutable(candidate)) return candidate;
  }

  return null;
}

export function isConvertibleEbookExtension(extension: string): boolean {
  return CONVERTIBLE_EBOOK_EXTENSIONS.has(extension.toLowerCase());
}

type ConversionResult = {
  filePath: string;
  format: string;
  sizeBytes: number;
  attempted: boolean;
  converted: boolean;
  reason?: string;
};

async function convertToPdfIfNeeded(
  filePath: string,
  sizeBytes: number
): Promise<ConversionResult> {
  const extension = extname(filePath).replace(/^\./u, "").toLowerCase();
  if (!isConvertibleEbookExtension(extension) || extension === "pdf") {
    return { filePath, format: extension || "unknown", sizeBytes, attempted: false, converted: false };
  }

  const ebookConvertBin = await resolveEbookConvertBinary();
  if (!ebookConvertBin) {
    return {
      filePath,
      format: extension,
      sizeBytes,
      attempted: true,
      converted: false,
      reason: "ebook-convert binary not found (expected Calibre cask at /opt/homebrew/bin/ebook-convert)",
    };
  }

  const pdfPath = `${filePath.slice(0, -(extension.length + 1))}.pdf`;
  const result = await runProcess(
    [ebookConvertBin, filePath, pdfPath, "--pdf-page-numbers"],
    EBOOK_CONVERT_TIMEOUT_MS
  );

  if (result.exitCode !== 0) {
    return {
      filePath,
      format: extension,
      sizeBytes,
      attempted: true,
      converted: false,
      reason: `ebook-convert failed (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 500)}`,
    };
  }

  let pdfSizeBytes: number;
  try {
    const pdfStat = await stat(pdfPath);
    if (!pdfStat.isFile() || pdfStat.size <= 0) {
      return {
        filePath,
        format: extension,
        sizeBytes,
        attempted: true,
        converted: false,
        reason: "ebook-convert reported success but produced no usable output file",
      };
    }
    pdfSizeBytes = pdfStat.size;
  } catch {
    return {
      filePath,
      format: extension,
      sizeBytes,
      attempted: true,
      converted: false,
      reason: "ebook-convert reported success but the output file is missing",
    };
  }

  // docs-ingest owns the file lifecycle from here; keep only the pdf artifact
  // (matches aa-book's own epub/mobi conversion behavior of dropping the source).
  await rm(filePath, { force: true }).catch(() => {});

  return {
    filePath: pdfPath,
    format: "pdf",
    sizeBytes: pdfSizeBytes,
    attempted: true,
    converted: true,
  };
}

export function hasFastPartnerAvailability(html: string): boolean {
  if (!html || !html.trim()) return false;
  return FAST_PARTNER_MARKERS.some((pattern) => pattern.test(html));
}

async function resolveAnnasArchiveBaseUrl(): Promise<string | null> {
  let mirrors: string[] = [];
  try {
    const raw = await readFile(AA_MIRRORS_CACHE_PATH, "utf8");
    mirrors = raw
      .split(/\r?\n/gu)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    // fall through to defaults
  }
  if (mirrors.length === 0) mirrors = AA_DEFAULT_MIRRORS;

  for (const mirror of mirrors) {
    const probe = await runProcess(["curl", "-sI", "--connect-timeout", "4", mirror], 6_000);
    const statusLine = probe.stdout.split(/\r?\n/gu)[0] ?? "";
    if (/\s(200|403|302)\b/u.test(statusLine)) return mirror;
  }
  return null;
}

async function verifyFastPartnerAvailable(md5: string): Promise<{ available: boolean; reason: string }> {
  const baseUrl = await resolveAnnasArchiveBaseUrl();
  if (!baseUrl) {
    return { available: false, reason: "no reachable Anna's Archive mirror to verify md5 page" };
  }

  const hasCookieFile = await access(AA_COOKIE_FILE_PATH, fsConstants.F_OK)
    .then(() => true)
    .catch(() => false);
  const cookieArgs = hasCookieFile ? ["-b", AA_COOKIE_FILE_PATH] : [];

  const result = await runProcess(
    ["curl", "-s", "--connect-timeout", "6", "--max-time", "12", ...cookieArgs, `${baseUrl}/md5/${md5}`],
    MD5_VERIFY_TIMEOUT_MS
  );

  if (result.exitCode !== 0 || !result.stdout.trim()) {
    return { available: false, reason: `unable to fetch /md5/${md5} page (exit ${result.exitCode})` };
  }

  return hasFastPartnerAvailability(result.stdout)
    ? { available: true, reason: "fast partner server link present on md5 page" }
    : { available: false, reason: "no fast partner server link found on md5 page (likely libgen-only slow links)" };
}

export type Md5VerificationAttempt = {
  md5: string;
  available: boolean;
  reason: string;
};

export type VerifiedCandidateSelection = {
  picked: { candidate: SearchCandidate; origin: "inference" | "fallback" } | null;
  attempts: Md5VerificationAttempt[];
};

/**
 * Orders candidates (inferred pick first, then remaining search results) and
 * walks them until one passes the `verify` check, falling through instead of
 * failing the whole run on the first bad candidate. `verify` is injected so
 * this stays unit-testable without shelling out to curl/agent-browser.
 */
export async function selectVerifiedCandidate(input: {
  candidates: SearchCandidate[];
  inferredMd5: string | null;
  maxAttempts: number;
  verify: (md5: string) => Promise<{ available: boolean; reason: string }>;
}): Promise<VerifiedCandidateSelection> {
  const ordered: Array<{ candidate: SearchCandidate; origin: "inference" | "fallback" }> = [];
  const seenMd5 = new Set<string>();

  if (input.inferredMd5) {
    const inferredCandidate = input.candidates.find((candidate) => candidate.md5 === input.inferredMd5);
    if (inferredCandidate) {
      ordered.push({ candidate: inferredCandidate, origin: "inference" });
      seenMd5.add(inferredCandidate.md5);
    }
  }
  for (const candidate of input.candidates) {
    if (seenMd5.has(candidate.md5)) continue;
    ordered.push({ candidate, origin: "fallback" });
    seenMd5.add(candidate.md5);
  }

  const attempts: Md5VerificationAttempt[] = [];
  for (const entry of ordered.slice(0, Math.max(1, input.maxAttempts))) {
    const verification = await input.verify(entry.candidate.md5);
    attempts.push({ md5: entry.candidate.md5, available: verification.available, reason: verification.reason });
    if (verification.available) {
      return { picked: { candidate: entry.candidate, origin: entry.origin }, attempts };
    }
  }

  // Every attempted candidate failed verification — nothing left to fall
  // through to. Let the caller decide how to fail (don't silently pick a
  // candidate known to have no working download tier).
  return { picked: null, attempts };
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
  let entries: Dirent[];
  try {
    entries = (await readdir(outputDir, { withFileTypes: true })) as Dirent[];
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

function formatResolvedPathDiagnostics(input: {
  outputDir: string;
  stdoutHint: string | null;
  beforeCount: number;
  afterCount: number;
  newCount: number;
}): string {
  return (
    `Unable to resolve downloaded file path in ${input.outputDir}. ` +
    `stdout hint: ${input.stdoutHint ?? "none"}. ` +
    `Files before: ${input.beforeCount}, after: ${input.afterCount}, new: ${input.newCount}`
  );
}

async function resolveDownloadedPath(
  rawOutput: string,
  outputDir: string,
  beforeEntries: OutputEntry[]
): Promise<string> {
  const resolveStartedAt = Date.now();
  const staleCutoffMs = resolveStartedAt - 5 * 60_000;
  const existingFromOutput = extractExistingPathFromOutput(rawOutput);
  let outputCandidate: OutputEntry | null = null;
  if (existingFromOutput) {
    for (let i = 0; i < 2; i += 1) {
      try {
        const details = await stat(existingFromOutput);
        if (details.isFile()) {
          outputCandidate = { path: existingFromOutput, mtimeMs: details.mtimeMs };
          break;
        }
      } catch {
        if (i === 0) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
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

  const diagnostics = formatResolvedPathDiagnostics({
    outputDir,
    stdoutHint: existingFromOutput,
    beforeCount: beforeEntries.length,
    afterCount: afterEntries.length,
    newCount: newEntries.length,
  });
  const assertFresh = (entry: OutputEntry, source: "stdout" | "directory-diff"): string => {
    if (entry.mtimeMs < staleCutoffMs) {
      throw new Error(
        `Resolved downloaded file from ${source} is stale: ${entry.path} (mtime ${new Date(entry.mtimeMs).toISOString()}). ${diagnostics}`
      );
    }
    return entry.path;
  };

  if (outputCandidate) return assertFresh(outputCandidate, "stdout");

  const newestNewEntry = newEntries[0];
  if (newestNewEntry) return assertFresh(newestNewEntry, "directory-diff");

  throw new Error(diagnostics);
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
  let result: Awaited<ReturnType<typeof infer>>;
  try {
    result = await infer(userPrompt, {
      task: "classification",
      model,
      system: BOOK_SELECTION_SYSTEM_PROMPT,
      component: "book-download",
      action: "book.select-md5",
      print: true,
      noTools: true,
      json: true,
      timeout: BOOK_SELECTION_TIMEOUT_MS,
      env: { ...process.env, TERM: "dumb" },
    });
  } catch (error) {
    return {
      md5: null,
      reason: `Inference failed (${error instanceof Error ? error.message : String(error)}). Fallback candidate used.`,
      model,
      provider: model,
    };
  }

  const assistantText = result.text;
  const selection = parseInferenceSelection(assistantText);

  if (!assistantText.trim() && selection.md5 == null) {
    return {
      md5: null,
      reason: `Inference failed: empty response after ${Date.now() - startedAt}ms`,
      model,
      provider: result.provider ?? model,
    };
  }

  return {
    md5: selection.md5,
    reason: selection.reason,
    confidence: selection.confidence,
    model: result.model ?? model,
    provider: result.provider,
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

            // Don't trust AA's per-md5 `format` label from search results —
            // a "pdf"-labeled md5 can turn out to be a zip of OCR fragments,
            // and some md5s have no fast-download tier at all (libgen-only
            // slow links), which makes `aa-book download` exit 1 bare. Walk
            // candidates (inferred pick first) until one verifies a Fast
            // Partner Server link, instead of committing to the first guess.
            const verification = await selectVerifiedCandidate({
              candidates,
              inferredMd5,
              maxAttempts: MAX_MD5_VERIFICATION_ATTEMPTS,
              verify: verifyFastPartnerAvailable,
            });

            for (const attempt of verification.attempts) {
              await emitOtelEvent({
                level: attempt.available ? "info" : "warn",
                source: "worker",
                component: "book-download",
                action: "book.md5.verification",
                success: attempt.available,
                error: attempt.available ? undefined : attempt.reason,
                metadata: { query, md5: attempt.md5 },
              });
            }

            if (!verification.picked) {
              throw new NonRetriableError(
                `No candidate MD5s with a verified Fast Partner download for query "${query}"${
                  requestedFormat ? ` (${requestedFormat})` : ""
                }. Attempts: ${verification.attempts
                  .map((attempt) => `${attempt.md5}: ${attempt.reason}`)
                  .join("; ")}`
              );
            }

            const { candidate: picked, origin } = verification.picked;
            if (origin === "inference") {
              return {
                md5: picked.md5,
                reason: `${inferred.reason} Verified fast-partner availability.`,
                selectedBy: "inference" as const,
                candidate: picked,
                confidence: inferred.confidence,
                model: inferred.model,
              };
            }

            return {
              md5: picked.md5,
              reason: `${inferred.reason} Falling back to next verified search candidate.`,
              selectedBy: "fallback" as const,
              candidate: picked,
              model: inferred.model,
            };
          });

      if (selected.selectedBy === "provided") {
        await step.run("verify-provided-md5", async () => {
          const verification = await verifyFastPartnerAvailable(selected.md5);
          if (!verification.available) {
            await emitOtelEvent({
              level: "warn",
              source: "worker",
              component: "book-download",
              action: "book.md5.verification",
              success: false,
              error: verification.reason,
              metadata: { md5: selected.md5, origin: "provided" },
            });
          }
          return verification;
        });
      }

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
        const command = [aaBookBin, "download", selected.md5, outputPath, "--keep-local"];
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

      // aa-book's own Calibre auto-convert only handles epub/mobi; azw3, fb2,
      // and any leftover epub/mobi (if aa-book's conversion failed) need a
      // conversion pass here, or docs-ingest rejects the extension outright.
      const convertedFile = await step.run("convert-to-pdf", async () => {
        const conversion = await convertToPdfIfNeeded(downloadResult.filePath, downloadResult.sizeBytes);
        if (conversion.attempted) {
          await emitOtelEvent({
            level: conversion.converted ? "info" : "warn",
            source: "worker",
            component: "book-download",
            action: "book.convert.ebook_to_pdf",
            success: conversion.converted,
            error: conversion.converted ? undefined : conversion.reason,
            metadata: {
              md5: selected.md5,
              originalPath: downloadResult.filePath,
              originalFormat: downloadResult.format,
              resultPath: conversion.filePath,
            },
          });
        }
        return conversion;
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
            outputPath: convertedFile.filePath,
            outputDir: outputPath,
            sizeBytes: convertedFile.sizeBytes,
            format: convertedFile.format ?? requestedFormat ?? null,
            converted: convertedFile.converted,
          },
        });
      });

      const nasBackup: NasBackupResult = await step.run("backup-to-nas", async (): Promise<NasBackupResult> => {
        try {
          const year = new Date().getFullYear().toString();
          const filename = basename(convertedFile.filePath);
          const nasDir = `${NAS_BOOKS_DIR}/${year}`;
          const nasFullPath = `${NAS_HOST}:${nasDir}/${filename}`;

          const mkdirResult = await runProcess(
            ["ssh", "-o", "ConnectTimeout=5", "-o", "BatchMode=yes", NAS_HOST, `mkdir -p '${nasDir}'`],
            NAS_BACKUP_TIMEOUT_MS
          );
          if (mkdirResult.exitCode !== 0) {
            return { backedUp: false as const, reason: `mkdir failed: ${mkdirResult.stderr.trim()}` };
          }

          const scpResult = await runProcess(
            ["scp", "-o", "ConnectTimeout=10", convertedFile.filePath, nasFullPath],
            NAS_BACKUP_TIMEOUT_MS
          );
          if (scpResult.exitCode !== 0) {
            return { backedUp: false as const, reason: `scp failed: ${scpResult.stderr.trim()}` };
          }

          return { backedUp: true as const, nasPath: `${nasDir}/${filename}` };
        } catch (error) {
          return {
            backedUp: false as const,
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      });
      const backupNasPath = nasBackup.backedUp ? nasBackup.nasPath : undefined;

      await step.run("otel-nas-backup", async () => {
        await emitOtelEvent({
          level: nasBackup.backedUp ? "info" : "warn",
          source: "worker",
          component: "book-download",
          action: nasBackup.backedUp ? "book.nas.backed_up" : "book.nas.backup_failed",
          success: nasBackup.backedUp,
          error: nasBackup.backedUp ? undefined : nasBackup.reason,
          metadata: {
            md5: selected.md5,
            localPath: convertedFile.filePath,
            nasPath: backupNasPath,
          },
        });
      });

      const resolvedTitle =
        event.data.title?.trim()
        || selected.candidate?.title?.trim()
        || inferTitle(undefined, convertedFile.filePath);
      const idempotencyKey =
        (event.data.idempotencyKey ?? "").trim()
        || `book:${selected.md5}:${basename(convertedFile.filePath).toLowerCase()}`;

      await step.sendEvent("emit-book-events", [
        {
          name: "docs/ingest.requested",
          data: {
            nasPath: backupNasPath,
            filePath: convertedFile.filePath,
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
            nasPath: backupNasPath,
            query: query || undefined,
            md5: selected.md5,
            reason,
            outputDir: outputPath,
            format: convertedFile.format ?? requestedFormat ?? selected.candidate?.format,
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
            localPath: convertedFile.filePath,
            nasPath: backupNasPath,
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
              path: convertedFile.filePath,
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
            outputPath: convertedFile.filePath,
            selectedBy: selected.selectedBy,
          },
        });
      });

      return {
        status: "queued",
        query: query || null,
        md5: selected.md5,
        title: resolvedTitle,
        path: convertedFile.filePath,
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
