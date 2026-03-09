import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ExecutionState } from "./types.js";

export type LocalSandboxMode = "minimal" | "full";

export interface LocalSandboxIdentity {
  sandboxId: string;
  slug: string;
  composeProjectName: string;
  requestId: string;
  workflowId: string;
  storyId: string;
}

export interface LocalSandboxPaths {
  rootDir: string;
  sandboxDir: string;
  repoDir: string;
  envPath: string;
  logsDir: string;
  artifactsDir: string;
  metadataPath: string;
  registryPath: string;
}

export interface GenerateLocalSandboxIdentityInput {
  workflowId: string;
  requestId: string;
  storyId: string;
  prefix?: string;
}

export interface ResolveLocalSandboxPathsOptions {
  rootDir?: string;
  repoDirName?: string;
}

export interface MaterializeLocalSandboxEnvOptions {
  path: string;
  identity: LocalSandboxIdentity;
  mode: LocalSandboxMode;
  baseSha: string;
  extra?: Record<string, string | undefined>;
}

export interface MaterializedSandboxEnv {
  path: string;
  values: Record<string, string>;
  content: string;
}

export interface LocalSandboxRegistryEntry {
  sandboxId: string;
  requestId: string;
  workflowId: string;
  storyId: string;
  slug: string;
  composeProjectName: string;
  mode: LocalSandboxMode;
  baseSha: string;
  path: string;
  envPath: string;
  state: ExecutionState;
  backend: "local";
  createdAt: string;
  updatedAt: string;
  teardownState: "active" | "tearing-down" | "removed";
}

export interface LocalSandboxRegistry {
  version: "2026-03-09";
  entries: LocalSandboxRegistryEntry[];
}

export const LOCAL_SANDBOX_MODES: readonly LocalSandboxMode[] = ["minimal", "full"] as const;
export const LOCAL_SANDBOX_REGISTRY_VERSION = "2026-03-09" as const;

const DEFAULT_SANDBOX_PREFIX = "jc";
const DEFAULT_REPO_DIR_NAME = "repo";
const DEFAULT_ROOT_DIR = join(homedir(), ".joelclaw", "sandboxes");

export function isLocalSandboxMode(value: unknown): value is LocalSandboxMode {
  return typeof value === "string" && (LOCAL_SANDBOX_MODES as readonly string[]).includes(value);
}

export function defaultLocalSandboxRoot(): string {
  return process.env.JOELCLAW_SANDBOX_ROOT?.trim() || DEFAULT_ROOT_DIR;
}

export function defaultLocalSandboxRegistryPath(rootDir = defaultLocalSandboxRoot()): string {
  return join(rootDir, "registry.json");
}

export function generateLocalSandboxIdentity(
  input: GenerateLocalSandboxIdentityInput,
): LocalSandboxIdentity {
  const workflowSlug = slugify(input.workflowId);
  const storySlug = slugify(input.storyId);
  const hash = shortHash(`${input.workflowId}:${input.storyId}:${input.requestId}`);
  const prefix = slugify(input.prefix || DEFAULT_SANDBOX_PREFIX);
  const slug = compactSlug([prefix, workflowSlug, storySlug, hash], 48);
  const sandboxId = `${slug}-${input.requestId.slice(0, 8).toLowerCase()}`;
  const composeProjectName = compactSlug([prefix, workflowSlug, hash], 40, "_");

  return {
    sandboxId,
    slug,
    composeProjectName,
    requestId: input.requestId,
    workflowId: input.workflowId,
    storyId: input.storyId,
  };
}

export function resolveLocalSandboxPaths(
  identity: LocalSandboxIdentity,
  options: ResolveLocalSandboxPathsOptions = {},
): LocalSandboxPaths {
  const rootDir = options.rootDir || defaultLocalSandboxRoot();
  const workflowSlug = slugify(identity.workflowId);
  const storySlug = slugify(identity.storyId);
  const sandboxDir = join(rootDir, workflowSlug, storySlug, identity.sandboxId);
  const repoDir = join(sandboxDir, options.repoDirName || DEFAULT_REPO_DIR_NAME);
  const envPath = join(sandboxDir, ".sandbox.env");
  const logsDir = join(sandboxDir, "logs");
  const artifactsDir = join(sandboxDir, "artifacts");
  const metadataPath = join(sandboxDir, "sandbox.json");
  const registryPath = defaultLocalSandboxRegistryPath(rootDir);

  return {
    rootDir,
    sandboxDir,
    repoDir,
    envPath,
    logsDir,
    artifactsDir,
    metadataPath,
    registryPath,
  };
}

export async function materializeLocalSandboxEnv(
  options: MaterializeLocalSandboxEnvOptions,
): Promise<MaterializedSandboxEnv> {
  const values: Record<string, string> = {
    JOELCLAW_SANDBOX_ID: options.identity.sandboxId,
    JOELCLAW_SANDBOX_SLUG: options.identity.slug,
    JOELCLAW_SANDBOX_MODE: options.mode,
    JOELCLAW_SANDBOX_REQUEST_ID: options.identity.requestId,
    JOELCLAW_SANDBOX_WORKFLOW_ID: options.identity.workflowId,
    JOELCLAW_SANDBOX_STORY_ID: options.identity.storyId,
    JOELCLAW_SANDBOX_BASE_SHA: options.baseSha,
    COMPOSE_PROJECT_NAME: options.identity.composeProjectName,
  };

  for (const [key, rawValue] of Object.entries(options.extra ?? {})) {
    if (rawValue === undefined) continue;
    values[key] = sanitizeEnvValue(rawValue);
  }

  const content = Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${quoteEnvValue(value)}`)
    .join("\n");

  await mkdir(dirname(options.path), { recursive: true });
  await writeFile(options.path, `${content}\n`, "utf8");

  return {
    path: options.path,
    values,
    content: `${content}\n`,
  };
}

export async function readLocalSandboxRegistry(
  registryPath = defaultLocalSandboxRegistryPath(),
): Promise<LocalSandboxRegistry> {
  try {
    const raw = await readFile(registryPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LocalSandboxRegistry>;

    if (parsed.version !== LOCAL_SANDBOX_REGISTRY_VERSION || !Array.isArray(parsed.entries)) {
      throw new Error("invalid registry shape");
    }

    return {
      version: LOCAL_SANDBOX_REGISTRY_VERSION,
      entries: parsed.entries.filter(isLocalSandboxRegistryEntry),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return emptyLocalSandboxRegistry();
    }

    throw error;
  }
}

export async function writeLocalSandboxRegistry(
  registry: LocalSandboxRegistry,
  registryPath = defaultLocalSandboxRegistryPath(),
): Promise<void> {
  await mkdir(dirname(registryPath), { recursive: true });
  await writeFile(
    registryPath,
    `${JSON.stringify(
      {
        version: LOCAL_SANDBOX_REGISTRY_VERSION,
        entries: registry.entries,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

export async function upsertLocalSandboxRegistryEntry(
  entry: LocalSandboxRegistryEntry,
  registryPath = defaultLocalSandboxRegistryPath(),
): Promise<LocalSandboxRegistry> {
  const registry = await readLocalSandboxRegistry(registryPath);
  const filtered = registry.entries.filter((candidate) => candidate.requestId !== entry.requestId);

  const nextRegistry: LocalSandboxRegistry = {
    version: LOCAL_SANDBOX_REGISTRY_VERSION,
    entries: [...filtered, entry].sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
  };

  await writeLocalSandboxRegistry(nextRegistry, registryPath);
  return nextRegistry;
}

export async function removeLocalSandboxRegistryEntry(
  requestId: string,
  registryPath = defaultLocalSandboxRegistryPath(),
): Promise<LocalSandboxRegistry> {
  const registry = await readLocalSandboxRegistry(registryPath);
  const nextRegistry: LocalSandboxRegistry = {
    version: LOCAL_SANDBOX_REGISTRY_VERSION,
    entries: registry.entries.filter((entry) => entry.requestId !== requestId),
  };

  await writeLocalSandboxRegistry(nextRegistry, registryPath);
  return nextRegistry;
}

export async function ensureLocalSandboxLayout(paths: LocalSandboxPaths): Promise<void> {
  await mkdir(paths.repoDir, { recursive: true });
  await mkdir(paths.logsDir, { recursive: true });
  await mkdir(paths.artifactsDir, { recursive: true });
}

export async function removeLocalSandboxLayout(paths: LocalSandboxPaths): Promise<void> {
  await rm(paths.sandboxDir, { recursive: true, force: true });
}

export function emptyLocalSandboxRegistry(): LocalSandboxRegistry {
  return {
    version: LOCAL_SANDBOX_REGISTRY_VERSION,
    entries: [],
  };
}

export function isLocalSandboxIdentity(value: unknown): value is LocalSandboxIdentity {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;

  return ["sandboxId", "slug", "composeProjectName", "requestId", "workflowId", "storyId"].every(
    (field) => typeof obj[field] === "string" && String(obj[field]).trim().length > 0,
  );
}

export function isLocalSandboxRegistryEntry(value: unknown): value is LocalSandboxRegistryEntry {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;

  return (
    isLocalSandboxIdentity(value) &&
    typeof obj.baseSha === "string" &&
    typeof obj.path === "string" &&
    typeof obj.envPath === "string" &&
    isLocalSandboxMode(obj.mode) &&
    typeof obj.state === "string" &&
    obj.backend === "local" &&
    typeof obj.createdAt === "string" &&
    typeof obj.updatedAt === "string" &&
    (obj.teardownState === "active" || obj.teardownState === "tearing-down" || obj.teardownState === "removed")
  );
}

function compactSlug(parts: string[], maxLength: number, separator = "-"): string {
  const slug = parts.filter(Boolean).join(separator).replace(new RegExp(`${separator}+`, "g"), separator);
  if (slug.length <= maxLength) return slug;
  return slug.slice(0, maxLength).replace(new RegExp(`${separator}+$`), "");
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "sandbox";
}

function shortHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 8);
}

function sanitizeEnvValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function quoteEnvValue(value: string): string {
  if (value === "") return '""';
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
  return JSON.stringify(value);
}
