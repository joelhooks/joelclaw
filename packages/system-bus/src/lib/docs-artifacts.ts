import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Atomic write: write to .tmp then rename — no partial artifacts on crash */
async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

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

export { DOCS_ARTIFACTS_DIR } from "@joelclaw/endpoint-resolver";

import {
  DOCS_ARTIFACTS_DIR,
  DOCS_ARTIFACTS_REMOTE_DIR,
  NAS_SSH_HOST,
} from "@joelclaw/endpoint-resolver";

const DOCS_ARTIFACTS_SSH_HOST = process.env.DOCS_ARTIFACTS_SSH_HOST || NAS_SSH_HOST;
const DOCS_ARTIFACTS_SSH_ROOT =
  process.env.DOCS_ARTIFACTS_SSH_ROOT || DOCS_ARTIFACTS_REMOTE_DIR;
const DOCS_ARTIFACTS_PREFER_SSH = ["1", "true", "yes", "on"].includes(
  (process.env.DOCS_ARTIFACTS_PREFER_SSH || "").toLowerCase()
);
const DOCS_ARTIFACT_SSH_TIMEOUT_MS = Number.parseInt(
  process.env.DOCS_ARTIFACT_SSH_TIMEOUT_MS || "20000",
  10
);

type ArtifactStage = "md" | "meta" | "chunks";

type SshResult = {
  code: number;
  stdout: string;
  stderr: string;
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function sshArtifactCommand(command: string, stdin?: string): Promise<SshResult> {
  if (!DOCS_ARTIFACTS_SSH_HOST) {
    throw new Error("DOCS_ARTIFACTS_PREFER_SSH requires DOCS_ARTIFACTS_SSH_HOST");
  }

  const child = Bun.spawn(
    [
      "ssh",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=8",
      DOCS_ARTIFACTS_SSH_HOST,
      command,
    ],
    {
      stdin: stdin === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  if (stdin !== undefined) {
    child.stdin!.write(stdin);
    child.stdin!.end();
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    const exit = Promise.race([
      child.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("docs_artifact_ssh_timeout")), DOCS_ARTIFACT_SSH_TIMEOUT_MS);
      }),
    ]);
    const [code, stdoutText, stderrText] = await Promise.all([exit, stdout, stderr]);
    return { code, stdout: stdoutText, stderr: stderrText };
  } catch (error) {
    child.kill();
    await child.exited.catch(() => undefined);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function remoteArtifactPath(path: string): string {
  const relativePath = path.slice(DOCS_ARTIFACTS_DIR.length).replace(/^[/\\]+/u, "");
  if (!path.startsWith(`${DOCS_ARTIFACTS_DIR}/`) || relativePath.includes("..")) {
    throw new Error(`Artifact path escapes configured root: ${path}`);
  }
  return `${DOCS_ARTIFACTS_SSH_ROOT.replace(/\/+$/u, "")}/${relativePath.replace(/\\/gu, "/")}`;
}

async function atomicWriteSsh(path: string, content: string): Promise<void> {
  const remotePath = remoteArtifactPath(path);
  const remoteTmp = `${remotePath}.${randomUUID().slice(0, 8)}.tmp`;
  const command = `set -e; mkdir -p -- ${shellQuote(dirname(remotePath))}; cat > ${shellQuote(remoteTmp)}; mv -- ${shellQuote(remoteTmp)} ${shellQuote(remotePath)}`;
  const result = await sshArtifactCommand(command, content);
  if (result.code !== 0) {
    throw new Error(`ssh artifact write failed (${result.code}): ${result.stderr.slice(0, 500)}`);
  }
}

async function readSsh(path: string): Promise<string | null> {
  const result = await sshArtifactCommand(`cat -- ${shellQuote(remoteArtifactPath(path))}`);
  if (result.code === 0) return result.stdout;
  if (result.code === 1) return null;
  throw new Error(`ssh artifact read failed (${result.code}): ${result.stderr.slice(0, 500)}`);
}

async function hasSsh(path: string): Promise<boolean> {
  const result = await sshArtifactCommand(`test -f ${shellQuote(remoteArtifactPath(path))}`);
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new Error(`ssh artifact check failed (${result.code}): ${result.stderr.slice(0, 500)}`);
}

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
  const path = artifactPath(docId, "md");
  if (DOCS_ARTIFACTS_PREFER_SSH) {
    await atomicWriteSsh(path, markdown);
  } else {
    await ensureDocArtifactDir(docId);
    await atomicWrite(path, markdown);
  }
  return path;
}

export async function saveMetadataArtifact(docId: string, meta: DocsMetadata): Promise<string> {
  const path = artifactPath(docId, "meta");
  const content = `${JSON.stringify(meta, null, 2)}\n`;
  if (DOCS_ARTIFACTS_PREFER_SSH) {
    await atomicWriteSsh(path, content);
  } else {
    await ensureDocArtifactDir(docId);
    await atomicWrite(path, content);
  }
  return path;
}

export async function saveChunksArtifact(
  docId: string,
  chunks: DocsChunkRecord[]
): Promise<string> {
  const path = artifactPath(docId, "chunks");
  const body = chunks.map((chunk) => JSON.stringify(chunk)).join("\n");
  const content = body.length > 0 ? `${body}\n` : "";
  if (DOCS_ARTIFACTS_PREFER_SSH) {
    await atomicWriteSsh(path, content);
  } else {
    await ensureDocArtifactDir(docId);
    await atomicWrite(path, content);
  }
  return path;
}

export async function loadMarkdownArtifact(docId: string): Promise<string | null> {
  const path = artifactPath(docId, "md");
  if (DOCS_ARTIFACTS_PREFER_SSH) return readSsh(path);
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

export async function loadMetadataArtifact(docId: string): Promise<DocsMetadata | null> {
  const path = artifactPath(docId, "meta");
  try {
    const raw = DOCS_ARTIFACTS_PREFER_SSH ? await readSsh(path) : await readFile(path, "utf8");
    return raw === null ? null : (JSON.parse(raw) as DocsMetadata);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

export async function loadChunksArtifact(docId: string): Promise<DocsChunkRecord[] | null> {
  const path = artifactPath(docId, "chunks");
  try {
    const raw = DOCS_ARTIFACTS_PREFER_SSH ? await readSsh(path) : await readFile(path, "utf8");
    if (raw === null) return null;
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
  const path = artifactPath(docId, stage);
  if (DOCS_ARTIFACTS_PREFER_SSH) return hasSsh(path);
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw error;
  }
}
