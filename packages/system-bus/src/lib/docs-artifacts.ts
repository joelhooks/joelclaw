import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DocsChunkRecord } from "../inngest/functions/docs-ingest";

export type DocsMetadata = {
  title: string;
  filename: string;
  file_type: string;
  page_count: number | null;
  sha256: string;
  primaryConceptId: string;
  conceptIds: string[];
  conceptSource: string;
  taxonomyVersion: string;
  storageCategory: string;
  documentType: string;
  tags: string[];
  summary: string;
  source_host?: string;
  nas_path: string;
  nas_paths: string[];
};

export const DOCS_ARTIFACTS_DIR =
  process.env.JOELCLAW_DOCS_ARTIFACTS_DIR?.trim()
  || process.env.DOCS_ARTIFACTS_DIR?.trim()
  || "/tmp/docs-artifacts";

type ArtifactStage = "md" | "meta" | "chunks";

function docArtifactDir(docId: string): string {
  return join(DOCS_ARTIFACTS_DIR, docId);
}

function artifactPath(docId: string, stage: ArtifactStage): string {
  const baseDir = docArtifactDir(docId);
  switch (stage) {
    case "md":
      return join(baseDir, `${docId}.md`);
    case "meta":
      return join(baseDir, `${docId}.meta.json`);
    case "chunks":
      return join(baseDir, `${docId}.chunks.jsonl`);
  }
}

async function ensureDocArtifactDir(docId: string): Promise<string> {
  const dir = docArtifactDir(docId);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function saveMarkdownArtifact(docId: string, markdown: string): Promise<string> {
  await ensureDocArtifactDir(docId);
  const path = artifactPath(docId, "md");
  await writeFile(path, markdown, "utf8");
  return path;
}

export async function saveMetadataArtifact(docId: string, meta: DocsMetadata): Promise<string> {
  await ensureDocArtifactDir(docId);
  const path = artifactPath(docId, "meta");
  await writeFile(path, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  return path;
}

export async function saveChunksArtifact(
  docId: string,
  chunks: DocsChunkRecord[]
): Promise<string> {
  await ensureDocArtifactDir(docId);
  const path = artifactPath(docId, "chunks");
  const body = chunks.map((chunk) => JSON.stringify(chunk)).join("\n");
  await writeFile(path, body.length > 0 ? `${body}\n` : "", "utf8");
  return path;
}

export async function loadMarkdownArtifact(docId: string): Promise<string | null> {
  try {
    return await readFile(artifactPath(docId, "md"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

export async function loadMetadataArtifact(docId: string): Promise<DocsMetadata | null> {
  try {
    const raw = await readFile(artifactPath(docId, "meta"), "utf8");
    return JSON.parse(raw) as DocsMetadata;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

export async function loadChunksArtifact(docId: string): Promise<DocsChunkRecord[] | null> {
  try {
    const raw = await readFile(artifactPath(docId, "chunks"), "utf8");
    const chunks = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as DocsChunkRecord);
    return chunks;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

export async function hasArtifact(docId: string, stage: ArtifactStage): Promise<boolean> {
  try {
    await access(artifactPath(docId, stage));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw error;
  }
}
