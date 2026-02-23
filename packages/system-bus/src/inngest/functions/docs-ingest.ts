import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname } from "node:path";
import { NonRetriableError } from "inngest";
import { chunkBookText, renderChunkForEmbedding, type BookChunkingResult } from "../../lib/book-chunk";
import { parsePiJsonAssistant, traceLlmGeneration, type LlmUsage } from "../../lib/langfuse";
import * as typesense from "../../lib/typesense";
import { emitMeasuredOtelEvent, emitOtelEvent } from "../../observability/emit";
import {
  getConceptById,
  isStorageCategory,
  TAXONOMY_CORE_V1,
  type ConceptId,
  type StorageCategory,
} from "../../taxonomy/core-v1";
import {
  resolveConcepts,
  resolveStorageCategory,
  type ConceptSource,
  type ResolveConceptsResult,
} from "../../taxonomy/resolve";
import { inngest } from "../client";

const DOCS_COLLECTION = "docs";
const DOCS_CHUNKS_COLLECTION = "docs_chunks";
const DOCS_TMP_DIR = "/tmp/docs-ingest";
const THREE_BODY_ROOT = "/Volumes/three-body";
const MANIFEST_FILE_NAME = "manifest.clean.jsonl";
const DOCS_INGEST_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.JOELCLAW_DOCS_INGEST_CONCURRENCY ?? "1", 10)
);
const DOCS_INGEST_THROTTLE_LIMIT = Math.max(
  1,
  Number.parseInt(process.env.JOELCLAW_DOCS_INGEST_THROTTLE_LIMIT ?? "20", 10)
);
const DOCS_INGEST_THROTTLE_PERIOD = `${Math.max(
  1,
  Number.parseInt(process.env.JOELCLAW_DOCS_INGEST_THROTTLE_PERIOD_SECONDS ?? "60", 10)
)}s` as `${number}s`;

function getManifestCandidatePaths(): string[] {
  return [
    process.env.MANIFEST_ARCHIVE_MANIFEST_PATH?.trim(),
    `/tmp/${MANIFEST_FILE_NAME}`,
    `/Volumes/three-body/.ingest-staging/${MANIFEST_FILE_NAME}`,
    process.env.HOME ? `${process.env.HOME}/Documents/${MANIFEST_FILE_NAME}` : undefined,
    `${homedir()}/Documents/${MANIFEST_FILE_NAME}`,
    "/Users/joel/Documents/manifest.clean.jsonl",
  ].filter((value): value is string => Boolean(value && value.length > 0));
}
const DOCS_TAXONOMY_MODEL =
  process.env.JOELCLAW_DOCS_TAXONOMY_MODEL?.trim() || "anthropic/claude-haiku-4-5";
const DOCS_TAXONOMY_TIMEOUT_MS = Math.max(
  10_000,
  Number.parseInt(process.env.JOELCLAW_DOCS_TAXONOMY_TIMEOUT_MS ?? "60000", 10)
);
const MANIFEST_LOOKUP_TIMEOUT_MS = Math.max(
  1_000,
  Number.parseInt(process.env.JOELCLAW_DOCS_MANIFEST_TIMEOUT_MS ?? "5000", 10)
);
const DOCS_ALLOW_RULES_FALLBACK = /^(1|true|yes)$/i.test(
  process.env.JOELCLAW_DOCS_ALLOW_RULES_FALLBACK ?? ""
);
const MINI_LM_MODEL_CONFIG = {
  model_name: "ts/all-MiniLM-L12-v2",
  indexing_prefix: "",
  query_prefix: "",
};

type DocsFileType = "pdf" | "md" | "txt";
type EvidenceTier = "section" | "snippet";
type TaxonomyClassificationStrategy = "backfill" | "llm" | "rules";

type ValidatedFile = {
  docId: string;
  nasPath: string;
  fileName: string;
  fileType: DocsFileType;
  sizeBytes: number;
  sha256: string;
  title: string;
};

type ExtractedTextArtifact = {
  textPath: string;
  characterCount: number;
  pageCount: number | null;
};

export type DocsTaxonomyClassification = {
  primaryConceptId: ConceptId;
  conceptIds: ConceptId[];
  conceptSource: ConceptSource;
  taxonomyVersion: string;
  storageCategory: StorageCategory;
  strategy: TaxonomyClassificationStrategy;
  llm?: {
    provider?: string;
    model?: string;
    usage?: LlmUsage;
    reason?: string;
  };
  backfill?: {
    manifestPath: string;
    entryId: string;
    provider?: string;
  };
  diagnostics: {
    aliasHits: number;
    mappedCount: number;
    unmappedCount: number;
    unmappedLabels: string[];
  };
};

type DocsDocumentRecord = {
  id: string;
  title: string;
  filename: string;
  storage_category: StorageCategory;
  document_type: string;
  file_type: DocsFileType;
  tags: string[];
  primary_concept_id: ConceptId;
  concept_ids: ConceptId[];
  concept_source: ConceptSource;
  taxonomy_version: string;
  summary: string;
  page_count?: number;
  size_bytes: number;
  added_at: number;
  nas_path: string;
  source_host?: string;
  sha256: string;
};

export type DocsChunkRecord = {
  id: string;
  doc_id: string;
  title: string;
  chunk_type: "section" | "snippet";
  chunk_index: number;
  heading_path: string[];
  context_prefix: string;
  parent_chunk_id?: string;
  prev_chunk_id?: string;
  next_chunk_id?: string;
  primary_concept_id: ConceptId;
  concept_ids: ConceptId[];
  concept_source: ConceptSource;
  taxonomy_version: string;
  source_entity_id: string;
  evidence_tier: EvidenceTier;
  parent_evidence_id?: string;
  content: string;
  retrieval_text: string;
  added_at: number;
};

export type ManifestInferenceRecord = {
  id: string;
  manifestPath: string;
  destinationPath: string;
  sourcePath: string;
  enrichmentCategory?: StorageCategory;
  enrichmentDocumentType?: string;
  enrichmentProvider?: string;
  tags: string[];
};

type TaxonomyLlmResult = {
  primaryConceptId: ConceptId;
  conceptIds: ConceptId[];
  storageCategory?: StorageCategory;
  reason?: string;
  provider?: string;
  model?: string;
  usage?: LlmUsage;
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "document";
}

function resolveTitle(inputTitle: string | null | undefined, fileName: string): string {
  const candidate = inputTitle?.trim();
  if (candidate) return candidate;
  const base = basename(fileName, extname(fileName));
  return base.trim() || "Untitled Document";
}

function resolveFileType(path: string): DocsFileType {
  const extension = extname(path).toLowerCase();
  if (extension === ".pdf") return "pdf";
  if (extension === ".md") return "md";
  if (extension === ".txt") return "txt";
  throw new NonRetriableError(`Unsupported docs-ingest file extension: ${extension || "(none)"}`);
}

function toInt32(value: number | null): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  if (rounded <= 0) return undefined;
  return Math.min(rounded, 2_147_483_647);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

async function runProcess(
  cmd: string[],
  stdinText?: string,
  timeoutMs?: number
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  const proc = Bun.spawn(cmd, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  if (proc.stdin) {
    if (stdinText) {
      proc.stdin.write(stdinText);
    }
    proc.stdin.end();
  }

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exitPromise = new Promise<number>((resolve) => {
    proc.exited.then((code) => resolve(code)).catch(() => resolve(-1));
  });
  const timeoutPromise =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? new Promise<number>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            try {
              proc.kill();
            } catch {
              // no-op
            }
            resolve(-1);
          }, timeoutMs);
        })
      : null;

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    timeoutPromise ? Promise.race([exitPromise, timeoutPromise]) : exitPromise,
  ]);
  if (timer) clearTimeout(timer);

  return {
    exitCode,
    stdout,
    stderr,
    timedOut,
  };
}

function decodeBytes(value: Uint8Array | null | undefined): string {
  if (!value || value.byteLength === 0) return "";
  return new TextDecoder().decode(value);
}

function runProcessSync(
  cmd: string[],
  timeoutMs?: number
): { exitCode: number; stdout: string; stderr: string; timedOut: boolean } {
  const proc = Bun.spawnSync(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    ...(typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? { timeout: timeoutMs }
      : {}),
  });

  const timedOut =
    typeof timeoutMs === "number" &&
    Number.isFinite(timeoutMs) &&
    timeoutMs > 0 &&
    proc.exitCode == null &&
    proc.success === false;

  return {
    exitCode: typeof proc.exitCode === "number" ? proc.exitCode : -1,
    stdout: decodeBytes(proc.stdout),
    stderr: decodeBytes(proc.stderr),
    timedOut,
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timeout_after_${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizePathKey(path: string): string {
  return path.replace(/\\/g, "/").trim().toLowerCase();
}

function sanitizeFilenameForManifest(raw: string): string {
  const parsed = {
    base: basename(raw),
    ext: extname(raw),
  };
  const ext = parsed.ext.replace(/[^a-zA-Z0-9.]/g, "").slice(0, 20);
  const maxBaseLength = Math.max(1, 200 - ext.length);

  let base = basename(parsed.base, parsed.ext)
    .replace(/[^a-zA-Z0-9.\s_-]/g, " ")
    .replace(/[\s-]+/g, "-")
    .replace(/_+/g, "_")
    .replace(/\.+/g, ".")
    .replace(/^[-_.]+|[-_.]+$/g, "");

  if (!base) base = "document";
  if (base.length > maxBaseLength) {
    base = base.slice(0, maxBaseLength).replace(/^[-_.]+|[-_.]+$/g, "");
  }
  if (!base) base = "document";

  return `${base}${ext}`;
}

function manifestCategoryDir(category: string | null | undefined): string {
  const normalized = category?.trim().toLowerCase();
  if (
    normalized === "programming" ||
    normalized === "business" ||
    normalized === "education" ||
    normalized === "design" ||
    normalized === "other"
  ) {
    return normalized;
  }
  return "uncategorized";
}

function normalizeManifestStorageCategory(
  category: string | null | undefined
): StorageCategory | undefined {
  if (!category) return undefined;
  const normalized = category.trim().toLowerCase();
  if (isStorageCategory(normalized)) return normalized;
  if (normalized === "podcast") return "podcasts";
  return undefined;
}

function buildManifestDestinationPath(
  filename: string,
  sourcePath: string,
  enrichmentCategory: string | null | undefined
): string {
  const sanitized = sanitizeFilenameForManifest(filename);
  const lowerSourcePath = sourcePath.toLowerCase();
  if (lowerSourcePath.includes("/clawd/podcasts/")) {
    return `${THREE_BODY_ROOT}/podcasts/${sanitized}`;
  }
  return `${THREE_BODY_ROOT}/books/${manifestCategoryDir(enrichmentCategory)}/${sanitized}`;
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to brace extraction
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1));
      if (parsed && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }

  return null;
}

const CONCEPT_ID_SET = new Set<ConceptId>(TAXONOMY_CORE_V1.map((concept) => concept.id));
const TAXONOMY_REFERENCE = TAXONOMY_CORE_V1.map(
  (concept) => `- ${concept.id}: ${concept.prefLabel} (${concept.scopeNote})`
).join("\n");
let manifestInferenceIndexPromise: Promise<Map<string, ManifestInferenceRecord>> | null = null;

export function resetManifestInferenceCache(): void {
  manifestInferenceIndexPromise = null;
}

function asConceptId(value: unknown): ConceptId | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim() as ConceptId;
  return CONCEPT_ID_SET.has(trimmed) ? trimmed : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

async function loadManifestInferenceIndex(): Promise<Map<string, ManifestInferenceRecord>> {
  if (manifestInferenceIndexPromise) return manifestInferenceIndexPromise;

  manifestInferenceIndexPromise = (async () => {
    let manifestPath: string | null = null;
    for (const candidatePath of getManifestCandidatePaths()) {
      try {
        await withTimeout(access(candidatePath), MANIFEST_LOOKUP_TIMEOUT_MS);
        manifestPath = candidatePath;
        break;
      } catch {
        // try next candidate
      }
    }
    if (!manifestPath) {
      return new Map<string, ManifestInferenceRecord>();
    }

    const text = await withTimeout(readFile(manifestPath, "utf8"), MANIFEST_LOOKUP_TIMEOUT_MS);
    const index = new Map<string, ManifestInferenceRecord>();
    const lines = text.split(/\r?\n/);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let parsed: Record<string, unknown>;
      try {
        const raw = JSON.parse(trimmed) as unknown;
        if (!raw || typeof raw !== "object") continue;
        parsed = raw as Record<string, unknown>;
      } catch {
        continue;
      }

      const id = typeof parsed.id === "string" ? parsed.id.trim() : "";
      const filename = typeof parsed.filename === "string" ? parsed.filename.trim() : "";
      const sourcePath = typeof parsed.sourcePath === "string" ? parsed.sourcePath.trim() : "";
      if (!id || !filename || !sourcePath) continue;

      const destinationPath = buildManifestDestinationPath(
        filename,
        sourcePath,
        typeof parsed.enrichmentCategory === "string" ? parsed.enrichmentCategory : null
      );
      const key = normalizePathKey(destinationPath);
      const next: ManifestInferenceRecord = {
        id,
        manifestPath,
        destinationPath,
        sourcePath,
        enrichmentCategory: normalizeManifestStorageCategory(
          typeof parsed.enrichmentCategory === "string" ? parsed.enrichmentCategory : null
        ),
        enrichmentDocumentType:
          typeof parsed.enrichmentDocumentType === "string"
            ? parsed.enrichmentDocumentType.trim()
            : undefined,
        enrichmentProvider:
          typeof parsed.enrichmentProvider === "string" ? parsed.enrichmentProvider.trim() : undefined,
        tags: asStringArray(parsed.tags),
      };

      const existing = index.get(key);
      if (!existing) {
        index.set(key, next);
        continue;
      }

      index.set(key, {
        ...existing,
        enrichmentCategory: existing.enrichmentCategory ?? next.enrichmentCategory,
        enrichmentDocumentType: existing.enrichmentDocumentType ?? next.enrichmentDocumentType,
        enrichmentProvider: existing.enrichmentProvider ?? next.enrichmentProvider,
        tags: [...new Set([...existing.tags, ...next.tags])],
      });
    }

    return index;
  })().catch(() => {
    manifestInferenceIndexPromise = null;
    return new Map<string, ManifestInferenceRecord>();
  });

  return manifestInferenceIndexPromise;
}

export async function resolveManifestInference(
  nasPath: string
): Promise<ManifestInferenceRecord | null> {
  const index = await loadManifestInferenceIndex();
  return index.get(normalizePathKey(nasPath)) ?? null;
}

async function inferTaxonomyWithLlm(input: {
  file: ValidatedFile;
  tags: string[];
  explicitStorageCategory?: string;
  sourceHost?: string;
  textSample: string;
  runId?: string;
  eventId?: string;
}): Promise<TaxonomyLlmResult | null> {
  const taxonomySystemPrompt = `You classify documents into canonical taxonomy concepts.
Return JSON only:
{
  "primaryConceptId": "<concept id>",
  "conceptIds": ["<concept id>", "..."],
  "storageCategory": "programming|business|education|design|other|uncategorized|podcasts",
  "reason": "<brief rationale>"
}

Allowed concept IDs:
${TAXONOMY_REFERENCE}

Rules:
- Choose only concept IDs from the allowed list.
- conceptIds must include primaryConceptId.
- Prefer 1-3 concepts.
- If uncertain, use jc:docs:general.
- Keep reasoning short (<= 160 chars).`;

  const taxonomyUserPrompt = [
    `title: ${input.file.title}`,
    `nasPath: ${input.file.nasPath}`,
    `fileType: ${input.file.fileType}`,
    `explicitStorageCategory: ${input.explicitStorageCategory ?? ""}`,
    `sourceHost: ${input.sourceHost ?? ""}`,
    `tags: ${input.tags.join(", ")}`,
    "",
    "textSample:",
    input.textSample.slice(0, 8_000),
  ].join("\n");

  const startedAt = Date.now();
  const proc = runProcessSync([
    "pi",
    "--no-tools",
    "--no-session",
    "--no-extensions",
    "--print",
    "--mode",
    "json",
    "--model",
    DOCS_TAXONOMY_MODEL,
    "--system-prompt",
    taxonomySystemPrompt,
    taxonomyUserPrompt,
  ], DOCS_TAXONOMY_TIMEOUT_MS);

  const parsedPi = parsePiJsonAssistant(proc.stdout);
  const assistantText = (parsedPi?.text ?? proc.stdout).trim();
  const payload = parseJsonObject(assistantText);
  const provider = parsedPi?.provider;
  const model = parsedPi?.model ?? DOCS_TAXONOMY_MODEL;
  const usage = parsedPi?.usage;

  if ((proc.exitCode !== 0 || proc.timedOut) && !assistantText) {
    await traceLlmGeneration({
      traceName: "joelclaw.docs.taxonomy",
      generationName: "docs.taxonomy.classify",
      component: "docs-ingest",
      action: "docs.taxonomy.classify",
      input: {
        title: input.file.title,
        nasPath: input.file.nasPath,
        tags: input.tags,
      },
      output: {
        stderr: proc.stderr.slice(0, 500),
      },
      provider,
      model,
      usage,
      durationMs: Date.now() - startedAt,
      error: proc.timedOut
        ? `pi taxonomy classification timed out after ${DOCS_TAXONOMY_TIMEOUT_MS}ms`
        : `pi exited with code ${proc.exitCode}`,
      metadata: {
        runId: input.runId,
        eventId: input.eventId,
      },
      runId: input.runId,
    });
    return null;
  }

  const primaryConceptId = asConceptId(payload?.primaryConceptId);
  const conceptIds = Array.isArray(payload?.conceptIds)
    ? payload!.conceptIds
        .map((value: unknown) => asConceptId(value))
        .filter((value): value is ConceptId => value != null)
    : [];

  const uniqueConceptIds = [...new Set(conceptIds)];
  if (primaryConceptId && !uniqueConceptIds.includes(primaryConceptId)) {
    uniqueConceptIds.unshift(primaryConceptId);
  }

  const storageCategory =
    typeof payload?.storageCategory === "string" && isStorageCategory(payload.storageCategory.trim())
      ? (payload.storageCategory.trim() as StorageCategory)
      : undefined;
  const reason =
    typeof payload?.reason === "string" ? payload.reason.trim().slice(0, 160) : undefined;

  const success = Boolean(primaryConceptId && uniqueConceptIds.length > 0);
  await traceLlmGeneration({
    traceName: "joelclaw.docs.taxonomy",
    generationName: "docs.taxonomy.classify",
    component: "docs-ingest",
    action: "docs.taxonomy.classify",
    input: {
      title: input.file.title,
      nasPath: input.file.nasPath,
      tags: input.tags,
    },
    output: success
      ? {
          primaryConceptId,
          conceptIds: uniqueConceptIds,
          storageCategory,
          reason,
        }
      : {
          parseError: "invalid taxonomy classifier output",
          raw: assistantText.slice(0, 1200),
        },
    provider,
    model,
    usage,
    durationMs: Date.now() - startedAt,
    error: success ? undefined : "invalid taxonomy classifier output",
    metadata: {
      runId: input.runId,
      eventId: input.eventId,
    },
    runId: input.runId,
  });

  if (!primaryConceptId || uniqueConceptIds.length === 0) return null;

  return {
    primaryConceptId,
    conceptIds: uniqueConceptIds,
    storageCategory,
    reason,
    provider,
    model,
    usage,
  };
}

async function extractPdfText(path: string): Promise<{ text: string; pageCount: number | null }> {
  const pythonScript = [
    "import json, sys",
    "from pypdf import PdfReader",
    "reader = PdfReader(sys.argv[1])",
    "parts = []",
    "for page in reader.pages:",
    "    try:",
    "        parts.append(page.extract_text() or '')",
    "    except Exception:",
    "        parts.append('')",
    "print(json.dumps({'text': '\\n\\n'.join(parts), 'page_count': len(reader.pages)}))",
  ].join("\n");

  const result = await runProcess(
    ["uv", "run", "--with", "pypdf", "python3", "-c", pythonScript, path]
  );

  if (result.exitCode === 0) {
    try {
      const parsed = JSON.parse(result.stdout) as { text?: string; page_count?: unknown };
      const text = typeof parsed.text === "string" ? parsed.text : "";
      const pageCount =
        typeof parsed.page_count === "number" && Number.isFinite(parsed.page_count)
          ? Math.max(0, Math.round(parsed.page_count))
          : null;
      if (normalizeWhitespace(text).length > 0) {
        return { text, pageCount };
      }
    } catch {
      // Fall through to string extraction fallback.
    }
  }

  const fallback = await runProcess(["strings", "-n", "6", path]);
  if (fallback.exitCode !== 0) {
    throw new NonRetriableError(
      `PDF extraction failed for ${path}: ${result.stderr.trim() || fallback.stderr.trim() || "unknown error"}`
    );
  }

  const cleaned = fallback.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && /[A-Za-z]{3}/.test(line))
    .join("\n");

  if (normalizeWhitespace(cleaned).length === 0) {
    throw new NonRetriableError(`PDF extraction returned no usable text for ${path}`);
  }

  return { text: cleaned, pageCount: null };
}

async function validateFile(input: {
  nasPath: string;
  title?: string;
}): Promise<ValidatedFile> {
  const nasPath = input.nasPath.trim();
  if (!nasPath) {
    throw new NonRetriableError("docs-ingest requires a non-empty nasPath");
  }

  await access(nasPath);
  const fileStat = await stat(nasPath);
  if (!fileStat.isFile()) {
    throw new NonRetriableError(`docs-ingest path is not a file: ${nasPath}`);
  }
  if (fileStat.size <= 0) {
    throw new NonRetriableError(`docs-ingest file is empty: ${nasPath}`);
  }

  const fileName = basename(nasPath);
  if (fileName.startsWith("._")) {
    throw new NonRetriableError(`docs-ingest skipping AppleDouble sidecar file: ${fileName}`);
  }

  const fileType = resolveFileType(nasPath);
  const sha256 = await sha256File(nasPath);
  const baseSlug = slugify(basename(fileName, extname(fileName))).slice(0, 48);
  const docId = `${baseSlug}-${sha256.slice(0, 12)}`;
  const title = resolveTitle(input.title, fileName);

  return {
    docId,
    nasPath,
    fileName,
    fileType,
    sizeBytes: fileStat.size,
    sha256,
    title,
  };
}

async function extractTextToFile(file: ValidatedFile): Promise<ExtractedTextArtifact> {
  await mkdir(DOCS_TMP_DIR, { recursive: true });

  let rawText = "";
  let pageCount: number | null = null;
  if (file.fileType === "pdf") {
    const extracted = await extractPdfText(file.nasPath);
    rawText = extracted.text;
    pageCount = extracted.pageCount;
  } else {
    rawText = await readFile(file.nasPath, "utf8");
  }

  const normalized = rawText.replace(/\r\n?/g, "\n").trim();
  const characterCount = normalized.length;
  if (characterCount === 0) {
    throw new NonRetriableError(`docs-ingest extracted empty text from ${file.nasPath}`);
  }

  const textPath = `${DOCS_TMP_DIR}/${file.docId}.txt`;
  await Bun.write(textPath, normalized);

  return {
    textPath,
    characterCount,
    pageCount,
  };
}

function inferDocumentType(file: ValidatedFile, storageCategory: StorageCategory): string {
  if (storageCategory === "podcasts") return "podcast";
  if (file.fileType === "pdf") return "book";
  if (file.fileType === "md") return "markdown";
  return "text";
}

function collectConceptLabels(input: {
  file: ValidatedFile;
  storageCategory?: string;
  tags?: string[];
  title?: string;
  sourceHost?: string;
  textSample?: string;
}): string[] {
  const labels = new Set<string>();
  const add = (value: string | undefined | null) => {
    const cleaned = value?.trim();
    if (cleaned) labels.add(cleaned);
  };

  add(input.storageCategory);
  add(input.title);
  add(input.file.title);
  add(input.sourceHost);
  add(input.file.fileType);

  for (const tag of input.tags ?? []) {
    add(tag);
  }

  const pathParts = input.file.nasPath
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  for (const part of pathParts) {
    add(part);
  }

  if (input.textSample) {
    const words = input.textSample
      .split(/\s+/)
      .map((word) => word.replace(/[^a-zA-Z0-9-]/g, "").toLowerCase())
      .filter((word) => word.length >= 4)
      .slice(0, 40);
    for (const word of words) {
      add(word);
    }
  }

  return [...labels];
}

function summarizeText(text: string): string {
  const sentence = text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+/)
    .slice(0, 3)
    .join(" ");
  return sentence.slice(0, 800);
}

function renderConceptLabels(conceptIds: ConceptId[]): string {
  const labels = conceptIds
    .map((conceptId) => getConceptById(conceptId)?.prefLabel ?? conceptId)
    .map((label) => normalizeWhitespace(label))
    .filter(Boolean);

  if (labels.length === 0) return "General";
  return labels.join(", ");
}

function renderRetrievalText(input: {
  title: string;
  headingPath: string[];
  conceptIds: ConceptId[];
  content: string;
}): string {
  const heading = input.headingPath.length > 0 ? input.headingPath.join(" > ") : "Document";
  const conceptLabels = renderConceptLabels(input.conceptIds);
  return normalizeWhitespace(
    `[DOC: ${input.title}]\n[PATH: ${heading}]\n[CONCEPTS: ${conceptLabels}]\n\n${input.content}`
  );
}

function conceptFromStorageCategory(category: StorageCategory | undefined): ConceptId | null {
  switch (category) {
    case "programming":
      return "jc:docs:programming";
    case "business":
      return "jc:docs:business";
    case "education":
      return "jc:docs:education";
    case "design":
      return "jc:docs:design";
    case "podcasts":
      return "jc:docs:podcast";
    case "other":
    case "uncategorized":
      return "jc:docs:general";
    default:
      return null;
  }
}

export function resolveBackfillConcepts(input: {
  inferredCategory?: StorageCategory;
  resolvedConceptIds: ConceptId[];
}): { primaryConceptId: ConceptId; conceptIds: ConceptId[] } {
  const inferredPrimary = conceptFromStorageCategory(input.inferredCategory);
  const fromRules = [...new Set(input.resolvedConceptIds)];

  if (inferredPrimary) {
    return {
      primaryConceptId: inferredPrimary,
      conceptIds: [inferredPrimary, ...fromRules.filter((conceptId) => conceptId !== inferredPrimary)],
    };
  }

  const primaryConceptId = fromRules[0] ?? "jc:docs:general";
  const conceptIds = fromRules.length > 0 ? fromRules : [primaryConceptId];
  return {
    primaryConceptId,
    conceptIds,
  };
}

export function buildBackfillClassification(input: {
  resolved: ResolveConceptsResult;
  manifestInference: ManifestInferenceRecord | null;
  explicitStorageCategory?: string;
  nasPath: string;
}): DocsTaxonomyClassification | null {
  const { manifestInference } = input;
  if (!manifestInference) return null;

  const hasBackfillInference = Boolean(
    manifestInference.enrichmentCategory
    || manifestInference.enrichmentDocumentType
    || manifestInference.enrichmentProvider
  );
  if (!hasBackfillInference) return null;

  const inferred = resolveBackfillConcepts({
    inferredCategory: manifestInference.enrichmentCategory,
    resolvedConceptIds: input.resolved.conceptIds,
  });
  const storageCategory = resolveStorageCategory({
    explicitCategory: input.explicitStorageCategory ?? manifestInference.enrichmentCategory,
    nasPath: input.nasPath,
    primaryConceptId: inferred.primaryConceptId,
  });

  return {
    primaryConceptId: inferred.primaryConceptId,
    conceptIds: inferred.conceptIds,
    conceptSource: "backfill",
    taxonomyVersion: input.resolved.taxonomyVersion,
    storageCategory,
    strategy: "backfill",
    backfill: {
      manifestPath: manifestInference.manifestPath,
      entryId: manifestInference.id,
      provider: manifestInference.enrichmentProvider,
    },
    diagnostics: input.resolved.diagnostics,
  };
}

export function buildChunkRecords(input: {
  docId: string;
  title: string;
  chunking: BookChunkingResult;
  primaryConceptId: ConceptId;
  conceptIds: ConceptId[];
  conceptSource: ConceptSource;
  taxonomyVersion: string;
  addedAt: number;
}): DocsChunkRecord[] {
  const chunks: DocsChunkRecord[] = [];

  for (const section of input.chunking.section_chunks) {
    chunks.push({
      id: section.chunk_id,
      doc_id: input.docId,
      title: input.title,
      chunk_type: "section",
      chunk_index: section.section_index,
      heading_path: section.heading_path,
      context_prefix: section.context_prefix,
      ...(section.prev_chunk_id ? { prev_chunk_id: section.prev_chunk_id } : {}),
      ...(section.next_chunk_id ? { next_chunk_id: section.next_chunk_id } : {}),
      primary_concept_id: input.primaryConceptId,
      concept_ids: input.conceptIds,
      concept_source: input.conceptSource,
      taxonomy_version: input.taxonomyVersion,
      source_entity_id: input.docId,
      evidence_tier: "section",
      content: section.text,
      retrieval_text: renderRetrievalText({
        title: input.title,
        headingPath: section.heading_path,
        conceptIds: input.conceptIds,
        content: renderChunkForEmbedding(section),
      }),
      added_at: input.addedAt,
    });
  }

  for (const snippet of input.chunking.snippet_chunks) {
    chunks.push({
      id: snippet.chunk_id,
      doc_id: input.docId,
      title: input.title,
      chunk_type: "snippet",
      chunk_index: snippet.snippet_index,
      heading_path: snippet.heading_path,
      context_prefix: snippet.context_prefix,
      parent_chunk_id: snippet.parent_chunk_id,
      ...(snippet.prev_chunk_id ? { prev_chunk_id: snippet.prev_chunk_id } : {}),
      ...(snippet.next_chunk_id ? { next_chunk_id: snippet.next_chunk_id } : {}),
      primary_concept_id: input.primaryConceptId,
      concept_ids: input.conceptIds,
      concept_source: input.conceptSource,
      taxonomy_version: input.taxonomyVersion,
      source_entity_id: input.docId,
      evidence_tier: "snippet",
      parent_evidence_id: snippet.parent_chunk_id,
      content: snippet.text,
      retrieval_text: renderRetrievalText({
        title: input.title,
        headingPath: snippet.heading_path,
        conceptIds: input.conceptIds,
        content: renderChunkForEmbedding(snippet),
      }),
      added_at: input.addedAt,
    });
  }

  return chunks;
}

function buildDocumentRecord(input: {
  file: ValidatedFile;
  extracted: ExtractedTextArtifact;
  storageCategory: StorageCategory;
  documentType: string;
  tags: string[];
  primaryConceptId: ConceptId;
  conceptIds: ConceptId[];
  conceptSource: ConceptSource;
  taxonomyVersion: string;
  summary: string;
  sourceHost?: string;
  addedAt: number;
}): DocsDocumentRecord {
  const pageCount = toInt32(input.extracted.pageCount);
  return {
    id: input.file.docId,
    title: input.file.title,
    filename: input.file.fileName,
    storage_category: input.storageCategory,
    document_type: input.documentType,
    file_type: input.file.fileType,
    tags: input.tags,
    primary_concept_id: input.primaryConceptId,
    concept_ids: input.conceptIds,
    concept_source: input.conceptSource,
    taxonomy_version: input.taxonomyVersion,
    summary: input.summary,
    ...(pageCount != null ? { page_count: pageCount } : {}),
    size_bytes: input.file.sizeBytes,
    added_at: input.addedAt,
    nas_path: input.file.nasPath,
    ...(input.sourceHost ? { source_host: input.sourceHost } : {}),
    sha256: input.file.sha256,
  };
}

async function ensureDocsCollections(): Promise<void> {
  await typesense.ensureCollection(DOCS_COLLECTION, {
    name: DOCS_COLLECTION,
    fields: [
      { name: "id", type: "string" },
      { name: "title", type: "string", infix: true },
      { name: "filename", type: "string", infix: true },
      { name: "storage_category", type: "string", facet: true },
      { name: "document_type", type: "string", facet: true },
      { name: "file_type", type: "string", facet: true },
      { name: "tags", type: "string[]", facet: true, optional: true },
      { name: "primary_concept_id", type: "string", facet: true, optional: true },
      { name: "concept_ids", type: "string[]", facet: true, optional: true },
      { name: "concept_source", type: "string", facet: true, optional: true },
      { name: "taxonomy_version", type: "string", facet: true, optional: true },
      { name: "summary", type: "string", optional: true },
      { name: "page_count", type: "int32", optional: true },
      { name: "size_bytes", type: "int64", optional: true },
      { name: "added_at", type: "int64" },
      { name: "nas_path", type: "string" },
      { name: "source_host", type: "string", optional: true },
      { name: "sha256", type: "string", optional: true },
    ],
    default_sorting_field: "added_at",
  });

  await typesense.ensureCollection(DOCS_CHUNKS_COLLECTION, {
    name: DOCS_CHUNKS_COLLECTION,
    fields: [
      { name: "id", type: "string" },
      { name: "doc_id", type: "string", facet: true },
      { name: "title", type: "string" },
      { name: "chunk_type", type: "string", facet: true },
      { name: "chunk_index", type: "int32" },
      { name: "heading_path", type: "string[]", facet: true, optional: true },
      { name: "context_prefix", type: "string", optional: true },
      { name: "parent_chunk_id", type: "string", facet: true, optional: true },
      { name: "prev_chunk_id", type: "string", optional: true },
      { name: "next_chunk_id", type: "string", optional: true },
      { name: "primary_concept_id", type: "string", facet: true, optional: true },
      { name: "concept_ids", type: "string[]", facet: true, optional: true },
      { name: "concept_source", type: "string", facet: true, optional: true },
      { name: "taxonomy_version", type: "string", facet: true, optional: true },
      { name: "source_entity_id", type: "string", facet: true },
      { name: "evidence_tier", type: "string", facet: true },
      { name: "parent_evidence_id", type: "string", facet: true, optional: true },
      { name: "content", type: "string" },
      { name: "retrieval_text", type: "string" },
      {
        name: "embedding",
        type: "float[]",
        embed: {
          from: ["retrieval_text"],
          model_config: MINI_LM_MODEL_CONFIG,
        },
      },
      { name: "added_at", type: "int64" },
    ],
    default_sorting_field: "added_at",
  });
}

async function deleteDocChunks(docId: string): Promise<void> {
  const filterBy = encodeURIComponent(`doc_id:=${docId}`);
  const response = await typesense.typesenseRequest(
    `/collections/${DOCS_CHUNKS_COLLECTION}/documents?filter_by=${filterBy}`,
    { method: "DELETE" }
  );
  if (!response.ok && response.status !== 404) {
    const errorText = await response.text();
    throw new Error(`Failed to delete existing chunk docs for ${docId}: ${errorText}`);
  }
}

export const docsIngest = inngest.createFunction(
  {
    id: "docs-ingest",
    concurrency: { limit: DOCS_INGEST_CONCURRENCY },
    throttle: {
      limit: DOCS_INGEST_THROTTLE_LIMIT,
      period: DOCS_INGEST_THROTTLE_PERIOD,
      key: '"docs-ingest"',
    },
    retries: 4,
    idempotency: 'event.data.nasPath + "::" + event.data.idempotencyKey',
  },
  { event: "docs/ingest.requested" },
  async ({ event, step }) => {
    const requestedTagsRaw: unknown[] = Array.isArray(event.data.tags) ? event.data.tags : [];
    const requestedTags = requestedTagsRaw
      .filter((tag: unknown): tag is string => typeof tag === "string")
      .map((tag: string) => tag.trim())
      .filter((tag: string) => tag.length > 0);
    const sourceHost = typeof event.data.sourceHost === "string" ? event.data.sourceHost.trim() : undefined;
    const explicitStorageCategory =
      typeof event.data.storageCategory === "string" ? event.data.storageCategory.trim() : undefined;
    const addedAt = Date.now();

    const validated = await step.run("validate-file", async () => {
      const metadata: Record<string, unknown> = {
        nasPath: event.data.nasPath,
      };
      return emitMeasuredOtelEvent(
        {
          level: "info",
          source: "worker",
          component: "docs-ingest",
          action: "docs.file.validated",
          metadata,
        },
        async () => {
          const result = await validateFile({
            nasPath: event.data.nasPath,
            title: event.data.title,
          });
          metadata.docId = result.docId;
          metadata.fileType = result.fileType;
          metadata.sizeBytes = result.sizeBytes;
          metadata.sha256 = result.sha256;
          return result;
        }
      );
    });

    const extracted = await step.run("extract-text", async () => {
      const metadata: Record<string, unknown> = {
        docId: validated.docId,
        nasPath: validated.nasPath,
        fileType: validated.fileType,
      };
      return emitMeasuredOtelEvent(
        {
          level: "info",
          source: "worker",
          component: "docs-ingest",
          action: "docs.text.extracted",
          metadata,
        },
        async () => {
          const result = await extractTextToFile(validated);
          metadata.textPath = result.textPath;
          metadata.characterCount = result.characterCount;
          metadata.pageCount = result.pageCount;
          return result;
        }
      );
    });

    const classification = await step.run("classify-taxonomy", async () => {
      const textSample = (await readFile(extracted.textPath, "utf8")).slice(0, 8_000);
      const manifestInference = await resolveManifestInference(validated.nasPath);
      const mergedTags = [
        ...requestedTags,
        ...(manifestInference?.tags ?? []),
      ];

      const labels = collectConceptLabels({
        file: validated,
        storageCategory: explicitStorageCategory ?? manifestInference?.enrichmentCategory,
        tags: mergedTags,
        title: event.data.title,
        sourceHost,
        textSample,
      });
      if (manifestInference?.enrichmentDocumentType) {
        labels.push(manifestInference.enrichmentDocumentType);
      }

      const resolved = resolveConcepts({ labels });
      let primaryConceptId: ConceptId = resolved.primaryConceptId;
      let conceptIds: ConceptId[] = resolved.conceptIds;
      let conceptSource: ConceptSource = resolved.conceptSource;
      let strategy: TaxonomyClassificationStrategy = "rules";
      let llmMeta: DocsTaxonomyClassification["llm"] | undefined;
      let backfillMeta: DocsTaxonomyClassification["backfill"] | undefined;
      let preferredStorageCategory: string | undefined =
        explicitStorageCategory ?? manifestInference?.enrichmentCategory;
      const hasBackfillInference = Boolean(
        manifestInference &&
          (manifestInference.enrichmentCategory ||
            manifestInference.enrichmentDocumentType ||
            manifestInference.enrichmentProvider)
      );
      const backfillClassification = buildBackfillClassification({
        resolved,
        manifestInference,
        explicitStorageCategory,
        nasPath: validated.nasPath,
      });

      if (backfillClassification) {
        primaryConceptId = backfillClassification.primaryConceptId;
        conceptIds = backfillClassification.conceptIds;
        conceptSource = backfillClassification.conceptSource;
        strategy = backfillClassification.strategy;
        backfillMeta = backfillClassification.backfill;
        preferredStorageCategory = backfillClassification.storageCategory;
      } else {
        const llmInference = await inferTaxonomyWithLlm({
          file: validated,
          tags: mergedTags,
          explicitStorageCategory,
          sourceHost,
          textSample,
          eventId: event.id,
        });

        if (llmInference) {
          primaryConceptId = llmInference.primaryConceptId;
          conceptIds = llmInference.conceptIds;
          conceptSource = "llm";
          strategy = "llm";
          preferredStorageCategory = explicitStorageCategory ?? llmInference.storageCategory;
          llmMeta = {
            provider: llmInference.provider,
            model: llmInference.model,
            usage: llmInference.usage,
            reason: llmInference.reason,
          };
        } else if (!DOCS_ALLOW_RULES_FALLBACK) {
          await emitOtelEvent({
            level: "error",
            source: "worker",
            component: "docs-ingest",
            action: "docs.taxonomy.inference_required",
            success: false,
            error: "taxonomy_inference_unavailable",
            metadata: {
              docId: validated.docId,
              nasPath: validated.nasPath,
              manifestMatched: Boolean(manifestInference),
              hasBackfillInference,
            },
          });
          throw new Error(
            `docs-ingest requires taxonomy inference (backfill or llm) for ${validated.nasPath}`
          );
        }
      }

      const storageCategory = resolveStorageCategory({
        explicitCategory: preferredStorageCategory,
        nasPath: validated.nasPath,
        primaryConceptId,
      });

      const classificationResult: DocsTaxonomyClassification = {
        primaryConceptId,
        conceptIds,
        conceptSource,
        taxonomyVersion: resolved.taxonomyVersion,
        storageCategory,
        strategy,
        ...(llmMeta ? { llm: llmMeta } : {}),
        ...(backfillMeta ? { backfill: backfillMeta } : {}),
        diagnostics: resolved.diagnostics,
      };

      await emitMeasuredOtelEvent(
        {
          level: "info",
          source: "worker",
          component: "docs-ingest",
          action: "docs.taxonomy.classified",
          metadata: {
            docId: validated.docId,
            storageCategory,
            primaryConceptId: classificationResult.primaryConceptId,
            conceptIds: classificationResult.conceptIds,
            conceptSource: classificationResult.conceptSource,
            taxonomyVersion: classificationResult.taxonomyVersion,
            strategy: classificationResult.strategy,
            llmModel: classificationResult.llm?.model,
            llmProvider: classificationResult.llm?.provider,
            llmReason: classificationResult.llm?.reason,
            backfillEntryId: classificationResult.backfill?.entryId,
            backfillProvider: classificationResult.backfill?.provider,
            mappedCount: classificationResult.diagnostics.mappedCount,
            unmappedCount: classificationResult.diagnostics.unmappedCount,
            aliasHits: classificationResult.diagnostics.aliasHits,
            unmappedLabels: classificationResult.diagnostics.unmappedLabels,
          },
        },
        async () => classificationResult
      );

      return classificationResult;
    });

    await step.run("ensure-docs-collections", async () => {
      await ensureDocsCollections();
      return { ensured: true };
    });

    await step.run("upsert-document", async () => {
      const text = await readFile(extracted.textPath, "utf8");
      const documentType = inferDocumentType(validated, classification.storageCategory);
      const document = buildDocumentRecord({
        file: validated,
        extracted,
        storageCategory: classification.storageCategory,
        documentType,
        tags: requestedTags,
        primaryConceptId: classification.primaryConceptId,
        conceptIds: classification.conceptIds,
        conceptSource: classification.conceptSource,
        taxonomyVersion: classification.taxonomyVersion,
        summary: summarizeText(text),
        sourceHost,
        addedAt,
      });

      await typesense.upsert(DOCS_COLLECTION, document as unknown as Record<string, unknown>);
      return {
        docId: document.id,
      };
    });

    const chunkSummary = await step.run("chunk-and-index", async () => {
      const text = await readFile(extracted.textPath, "utf8");
      const chunking = chunkBookText(validated.docId, text);

      const chunkRecords = buildChunkRecords({
        docId: validated.docId,
        title: validated.title,
        chunking,
        primaryConceptId: classification.primaryConceptId,
        conceptIds: classification.conceptIds,
        conceptSource: classification.conceptSource,
        taxonomyVersion: classification.taxonomyVersion,
        addedAt,
      });

      await emitMeasuredOtelEvent(
        {
          level: "info",
          source: "worker",
          component: "docs-ingest",
          action: "docs.chunking.profiled",
          metadata: {
            docId: validated.docId,
            sectionCount: chunking.stats.section_chunks,
            snippetCount: chunking.stats.snippet_chunks,
            avgSectionTokens: chunking.stats.avg_section_tokens,
            avgSnippetTokens: chunking.stats.avg_snippet_tokens,
            profileVersion: "book-chunk.v1",
          },
        },
        async () => chunking.stats
      );

      await deleteDocChunks(validated.docId);
      const importResult = await typesense.bulkImport(
        DOCS_CHUNKS_COLLECTION,
        chunkRecords as unknown as Record<string, unknown>[],
        "upsert"
      );

      await emitMeasuredOtelEvent(
        {
          level: importResult.errors > 0 ? "warn" : "info",
          source: "worker",
          component: "docs-ingest",
          action: "docs.chunks.indexed",
          metadata: {
            docId: validated.docId,
            indexed: importResult.success,
            errors: importResult.errors,
            sectionCount: chunking.stats.section_chunks,
            snippetCount: chunking.stats.snippet_chunks,
          },
        },
        async () => importResult
      );

      return {
        indexed: importResult.success,
        errors: importResult.errors,
        sectionCount: chunking.stats.section_chunks,
        snippetCount: chunking.stats.snippet_chunks,
      };
    });

    await step.sendEvent("emit-completed", {
      name: "docs/ingest.completed",
      data: {
        docId: validated.docId,
        title: validated.title,
        nasPath: validated.nasPath,
        storageCategory: classification.storageCategory,
        primaryConceptId: classification.primaryConceptId,
        conceptIds: classification.conceptIds,
        taxonomyVersion: classification.taxonomyVersion,
        chunksIndexed: chunkSummary.indexed,
        sectionChunks: chunkSummary.sectionCount,
        snippetChunks: chunkSummary.snippetCount,
      },
    });

    await step.run("cleanup-text-artifact", async () => {
      await rm(extracted.textPath, { force: true }).catch(() => {});
      return { removed: true };
    });

    return {
      docId: validated.docId,
      title: validated.title,
      nasPath: validated.nasPath,
      storageCategory: classification.storageCategory,
      primaryConceptId: classification.primaryConceptId,
      conceptIds: classification.conceptIds,
      taxonomyVersion: classification.taxonomyVersion,
      chunksIndexed: chunkSummary.indexed,
      sectionChunks: chunkSummary.sectionCount,
      snippetChunks: chunkSummary.snippetCount,
      chunkErrors: chunkSummary.errors,
    };
  }
);
