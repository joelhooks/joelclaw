import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ExecutionState } from "./types.js";

export type LocalSandboxMode = "minimal" | "full";
export type LocalSandboxTeardownState = "active" | "tearing-down" | "removed";
export type LocalSandboxRetentionPolicy = "active" | "ttl";
export type LocalSandboxDevcontainerStrategy = "copy" | "symlink";

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
  devcontainerPath: string;
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

export interface ResolveLocalSandboxRetentionOptions {
  state: ExecutionState;
  updatedAt?: string;
}

export interface LocalSandboxRetentionDecision {
  policy: LocalSandboxRetentionPolicy;
  cleanupAfter?: string;
  reason: string;
}

export interface MaterializeLocalSandboxDevcontainerOptions {
  sourceRepoDir: string;
  targetRepoDir: string;
  strategy?: LocalSandboxDevcontainerStrategy;
}

export interface MaterializedLocalSandboxDevcontainer {
  sourcePath: string;
  targetPath: string;
  strategy: LocalSandboxDevcontainerStrategy;
  materialized: boolean;
  excludedPaths: string[];
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
  repoPath?: string;
  envPath: string;
  metadataPath?: string;
  state: ExecutionState;
  backend: "local";
  createdAt: string;
  updatedAt: string;
  teardownState: LocalSandboxTeardownState;
  retentionPolicy?: LocalSandboxRetentionPolicy;
  cleanupAfter?: string;
  cleanupReason?: string;
  devcontainerStrategy?: LocalSandboxDevcontainerStrategy;
}

export interface LocalSandboxRegistry {
  version: "2026-03-09";
  entries: LocalSandboxRegistryEntry[];
}

export interface PruneExpiredLocalSandboxesOptions {
  registryPath?: string;
  now?: Date;
}

export interface PruneExpiredLocalSandboxesResult {
  registry: LocalSandboxRegistry;
  removedSandboxIds: string[];
  retainedSandboxIds: string[];
  reconciledSandboxIds: string[];
}

export interface CleanupLocalSandboxesOptions {
  registryPath?: string;
  requestIds?: string[];
  sandboxIds?: string[];
  allTerminal?: boolean;
  expiredOnly?: boolean;
  force?: boolean;
  dryRun?: boolean;
  now?: Date;
}

export interface CleanupLocalSandboxesResult {
  registry: LocalSandboxRegistry;
  matchedSandboxIds: string[];
  removedSandboxIds: string[];
  skipped: Array<{
    sandboxId: string;
    requestId: string;
    reason: string;
  }>;
  reconciledSandboxIds: string[];
  dryRun: boolean;
}

export interface ReconcileLocalSandboxRegistryOptions {
  registryPath?: string;
}

export interface ReconcileLocalSandboxRegistryResult {
  registry: LocalSandboxRegistry;
  reconciledSandboxIds: string[];
}

export const LOCAL_SANDBOX_MODES: readonly LocalSandboxMode[] = ["minimal", "full"] as const;
export const LOCAL_SANDBOX_DEVCONTAINER_STRATEGIES: readonly LocalSandboxDevcontainerStrategy[] = [
  "copy",
  "symlink",
] as const;
export const LOCAL_SANDBOX_REGISTRY_VERSION = "2026-03-09" as const;
export const LOCAL_SANDBOX_RETENTION_HOURS = {
  completed: 24,
  cancelled: 24,
  failed: 72,
} as const;

const DEFAULT_SANDBOX_PREFIX = "jc";
const DEFAULT_REPO_DIR_NAME = "repo";
const DEFAULT_ROOT_DIR = join(homedir(), ".joelclaw", "sandboxes");
const DEVCONTAINER_DIR_NAME = ".devcontainer";

export function isLocalSandboxMode(value: unknown): value is LocalSandboxMode {
  return typeof value === "string" && (LOCAL_SANDBOX_MODES as readonly string[]).includes(value);
}

export function isLocalSandboxDevcontainerStrategy(
  value: unknown,
): value is LocalSandboxDevcontainerStrategy {
  return (
    typeof value === "string" &&
    (LOCAL_SANDBOX_DEVCONTAINER_STRATEGIES as readonly string[]).includes(value)
  );
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
  const slug = compactSlugWithHash([prefix, workflowSlug, storySlug], 48, hash);
  const sandboxId = slug;
  const composeProjectName = compactSlugWithHash([prefix, workflowSlug], 40, hash, "_");

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
  const devcontainerPath = join(repoDir, DEVCONTAINER_DIR_NAME);

  return {
    rootDir,
    sandboxDir,
    repoDir,
    envPath,
    logsDir,
    artifactsDir,
    metadataPath,
    registryPath,
    devcontainerPath,
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

export function resolveLocalSandboxRetention(
  options: ResolveLocalSandboxRetentionOptions,
): LocalSandboxRetentionDecision {
  const updatedAt = options.updatedAt ? new Date(options.updatedAt) : new Date();

  if (options.state === "completed") {
    return {
      policy: "ttl",
      cleanupAfter: addHours(updatedAt, LOCAL_SANDBOX_RETENTION_HOURS.completed).toISOString(),
      reason: "retain completed local sandboxes for 24 hours so operators can inspect artifacts before cleanup",
    };
  }

  if (options.state === "cancelled") {
    return {
      policy: "ttl",
      cleanupAfter: addHours(updatedAt, LOCAL_SANDBOX_RETENTION_HOURS.cancelled).toISOString(),
      reason: "retain cancelled local sandboxes for 24 hours so operators can inspect partial state before cleanup",
    };
  }

  if (options.state === "failed") {
    return {
      policy: "ttl",
      cleanupAfter: addHours(updatedAt, LOCAL_SANDBOX_RETENTION_HOURS.failed).toISOString(),
      reason: "retain failed local sandboxes for 72 hours so operators can debug the failure before cleanup",
    };
  }

  return {
    policy: "active",
    reason: "active local sandboxes stay resident until they reach a terminal state",
  };
}

export async function materializeLocalSandboxDevcontainer(
  options: MaterializeLocalSandboxDevcontainerOptions,
): Promise<MaterializedLocalSandboxDevcontainer> {
  const strategy = options.strategy ?? "copy";
  const sourcePath = join(options.sourceRepoDir, DEVCONTAINER_DIR_NAME);
  const targetPath = join(options.targetRepoDir, DEVCONTAINER_DIR_NAME);

  try {
    const stat = await lstat(sourcePath);
    if (!stat.isDirectory()) {
      throw new Error(`${sourcePath} exists but is not a directory`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return {
        sourcePath,
        targetPath,
        strategy,
        materialized: false,
        excludedPaths: [],
      };
    }

    throw error;
  }

  await mkdir(options.targetRepoDir, { recursive: true });
  await rm(targetPath, { recursive: true, force: true });

  if (strategy === "symlink") {
    await symlink(sourcePath, targetPath, "dir");
    return {
      sourcePath,
      targetPath,
      strategy,
      materialized: true,
      excludedPaths: [],
    };
  }

  const excludedPaths: string[] = [];
  await copyDevcontainerDirectory(sourcePath, targetPath, excludedPaths);

  return {
    sourcePath,
    targetPath,
    strategy,
    materialized: true,
    excludedPaths: excludedPaths.sort(),
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

export async function reconcileLocalSandboxRegistry(
  options: ReconcileLocalSandboxRegistryOptions = {},
): Promise<ReconcileLocalSandboxRegistryResult> {
  const registryPath = options.registryPath ?? defaultLocalSandboxRegistryPath();
  const registry = await readLocalSandboxRegistry(registryPath);
  const reconciledSandboxIds: string[] = [];
  const nextEntries = await Promise.all(
    registry.entries.map(async (entry) => {
      const reconciled = await reconcileLocalSandboxRegistryEntry(entry);
      if (hasLocalSandboxRegistryDrift(entry, reconciled)) {
        reconciledSandboxIds.push(entry.sandboxId);
      }
      return reconciled;
    }),
  );

  if (reconciledSandboxIds.length === 0) {
    return {
      registry,
      reconciledSandboxIds,
    };
  }

  const nextRegistry: LocalSandboxRegistry = {
    version: LOCAL_SANDBOX_REGISTRY_VERSION,
    entries: nextEntries.sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
  };

  await writeLocalSandboxRegistry(nextRegistry, registryPath);

  return {
    registry: nextRegistry,
    reconciledSandboxIds: reconciledSandboxIds.sort((left, right) => left.localeCompare(right)),
  };
}

export async function pruneExpiredLocalSandboxes(
  options: PruneExpiredLocalSandboxesOptions = {},
): Promise<PruneExpiredLocalSandboxesResult> {
  const registryPath = options.registryPath ?? defaultLocalSandboxRegistryPath();
  const now = options.now ?? new Date();
  const reconciled = await reconcileLocalSandboxRegistry({ registryPath });
  const registry = reconciled.registry;
  const removedSandboxIds: string[] = [];
  const retainedEntries: LocalSandboxRegistryEntry[] = [];

  for (const entry of registry.entries) {
    if (!isLocalSandboxEntryExpired(entry, now)) {
      retainedEntries.push(entry);
      continue;
    }

    await rm(resolveSandboxDirFromEntry(entry), { recursive: true, force: true });
    removedSandboxIds.push(entry.sandboxId);
  }

  const nextRegistry: LocalSandboxRegistry = {
    version: LOCAL_SANDBOX_REGISTRY_VERSION,
    entries: retainedEntries,
  };

  await writeLocalSandboxRegistry(nextRegistry, registryPath);

  return {
    registry: nextRegistry,
    removedSandboxIds,
    retainedSandboxIds: retainedEntries.map((entry) => entry.sandboxId),
    reconciledSandboxIds: reconciled.reconciledSandboxIds,
  };
}

export async function cleanupLocalSandboxes(
  options: CleanupLocalSandboxesOptions = {},
): Promise<CleanupLocalSandboxesResult> {
  const registryPath = options.registryPath ?? defaultLocalSandboxRegistryPath();
  const now = options.now ?? new Date();
  const reconciled = await reconcileLocalSandboxRegistry({ registryPath });
  const registry = reconciled.registry;
  const requestIds = new Set((options.requestIds ?? []).map((value) => value.trim()).filter(Boolean));
  const sandboxIds = new Set((options.sandboxIds ?? []).map((value) => value.trim()).filter(Boolean));
  const removedRequestIds = new Set<string>();
  const removedSandboxIds: string[] = [];
  const matchedSandboxIds: string[] = [];
  const skipped: CleanupLocalSandboxesResult["skipped"] = [];

  const shouldMatchEntry = (entry: LocalSandboxRegistryEntry): boolean => {
    if (requestIds.size > 0 && requestIds.has(entry.requestId)) return true;
    if (sandboxIds.size > 0 && sandboxIds.has(entry.sandboxId)) return true;
    if (options.expiredOnly && isLocalSandboxEntryExpired(entry, now)) return true;
    if (options.allTerminal && isTerminalExecutionState(entry.state)) return true;
    return false;
  };

  for (const entry of registry.entries) {
    if (!shouldMatchEntry(entry)) {
      continue;
    }

    matchedSandboxIds.push(entry.sandboxId);

    if (!options.force && !isTerminalExecutionState(entry.state)) {
      skipped.push({
        sandboxId: entry.sandboxId,
        requestId: entry.requestId,
        reason: `sandbox is ${entry.state}; pass --force to remove active sandboxes`,
      });
      continue;
    }

    removedRequestIds.add(entry.requestId);
    removedSandboxIds.push(entry.sandboxId);

    if (!options.dryRun) {
      await rm(resolveSandboxDirFromEntry(entry), { recursive: true, force: true });
    }
  }

  const nextRegistry: LocalSandboxRegistry = {
    version: LOCAL_SANDBOX_REGISTRY_VERSION,
    entries: registry.entries.filter((entry) => !removedRequestIds.has(entry.requestId)),
  };

  if (!options.dryRun) {
    await writeLocalSandboxRegistry(nextRegistry, registryPath);
  }

  return {
    registry: options.dryRun ? registry : nextRegistry,
    matchedSandboxIds,
    removedSandboxIds,
    skipped,
    reconciledSandboxIds: reconciled.reconciledSandboxIds,
    dryRun: options.dryRun ?? false,
  };
}

export async function ensureLocalSandboxLayout(paths: LocalSandboxPaths): Promise<void> {
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
    (obj.repoPath === undefined || typeof obj.repoPath === "string") &&
    (obj.metadataPath === undefined || typeof obj.metadataPath === "string") &&
    (obj.retentionPolicy === undefined || obj.retentionPolicy === "active" || obj.retentionPolicy === "ttl") &&
    (obj.cleanupAfter === undefined || typeof obj.cleanupAfter === "string") &&
    (obj.cleanupReason === undefined || typeof obj.cleanupReason === "string") &&
    (obj.devcontainerStrategy === undefined || isLocalSandboxDevcontainerStrategy(obj.devcontainerStrategy)) &&
    (obj.teardownState === "active" || obj.teardownState === "tearing-down" || obj.teardownState === "removed")
  );
}

export function isLocalSandboxEntryExpired(
  entry: LocalSandboxRegistryEntry,
  now = new Date(),
): boolean {
  return shouldPruneSandboxEntry(entry, now);
}

type LocalSandboxMetadataRecord = {
  state?: unknown;
  updatedAt?: unknown;
  teardownState?: unknown;
  baseSha?: unknown;
  sandbox?: {
    mode?: unknown;
    path?: unknown;
    repoPath?: unknown;
    envPath?: unknown;
    metadataPath?: unknown;
    cleanupAfter?: unknown;
  };
  retention?: {
    policy?: unknown;
    cleanupAfter?: unknown;
    reason?: unknown;
  };
};

async function reconcileLocalSandboxRegistryEntry(
  entry: LocalSandboxRegistryEntry,
): Promise<LocalSandboxRegistryEntry> {
  const metadata = await readLocalSandboxMetadata(entry.metadataPath);
  if (!metadata) {
    return entry;
  }

  const nextEntry: LocalSandboxRegistryEntry = {
    ...entry,
  };

  if (isExecutionStateValue(metadata.state)) {
    nextEntry.state = metadata.state;
  }

  if (typeof metadata.updatedAt === "string" && metadata.updatedAt.trim().length > 0) {
    nextEntry.updatedAt = metadata.updatedAt;
  }

  if (isLocalSandboxTeardownStateValue(metadata.teardownState)) {
    nextEntry.teardownState = metadata.teardownState;
  }

  if (typeof metadata.baseSha === "string" && metadata.baseSha.trim().length > 0) {
    nextEntry.baseSha = metadata.baseSha;
  }

  if (metadata.sandbox) {
    if (isLocalSandboxMode(metadata.sandbox.mode)) {
      nextEntry.mode = metadata.sandbox.mode;
    }
    if (typeof metadata.sandbox.path === "string" && metadata.sandbox.path.trim().length > 0) {
      nextEntry.path = metadata.sandbox.path;
    }
    if (typeof metadata.sandbox.repoPath === "string" && metadata.sandbox.repoPath.trim().length > 0) {
      nextEntry.repoPath = metadata.sandbox.repoPath;
    }
    if (typeof metadata.sandbox.envPath === "string" && metadata.sandbox.envPath.trim().length > 0) {
      nextEntry.envPath = metadata.sandbox.envPath;
    }
    if (typeof metadata.sandbox.metadataPath === "string" && metadata.sandbox.metadataPath.trim().length > 0) {
      nextEntry.metadataPath = metadata.sandbox.metadataPath;
    }
  }

  if (metadata.retention) {
    if (isLocalSandboxRetentionPolicyValue(metadata.retention.policy)) {
      nextEntry.retentionPolicy = metadata.retention.policy;
    }
    if (typeof metadata.retention.cleanupAfter === "string" && metadata.retention.cleanupAfter.trim().length > 0) {
      nextEntry.cleanupAfter = metadata.retention.cleanupAfter;
    }
    if (typeof metadata.retention.reason === "string" && metadata.retention.reason.trim().length > 0) {
      nextEntry.cleanupReason = metadata.retention.reason;
    }
  }

  if (isTerminalExecutionState(nextEntry.state)) {
    if (
      nextEntry.cleanupAfter === undefined &&
      typeof metadata.sandbox?.cleanupAfter === "string" &&
      metadata.sandbox.cleanupAfter.trim().length > 0
    ) {
      nextEntry.cleanupAfter = metadata.sandbox.cleanupAfter;
    }
  } else {
    nextEntry.retentionPolicy = "active";
    delete nextEntry.cleanupAfter;
    delete nextEntry.cleanupReason;
  }

  return nextEntry;
}

async function readLocalSandboxMetadata(
  metadataPath?: string,
): Promise<LocalSandboxMetadataRecord | null> {
  if (!metadataPath) {
    return null;
  }

  try {
    const raw = await readFile(metadataPath, "utf8");
    const parsed = JSON.parse(raw) as LocalSandboxMetadataRecord;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function hasLocalSandboxRegistryDrift(
  entry: LocalSandboxRegistryEntry,
  nextEntry: LocalSandboxRegistryEntry,
): boolean {
  return JSON.stringify(entry) !== JSON.stringify(nextEntry);
}

function isExecutionStateValue(value: unknown): value is ExecutionState {
  return (
    value === "pending" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  );
}

function isLocalSandboxTeardownStateValue(value: unknown): value is LocalSandboxTeardownState {
  return value === "active" || value === "tearing-down" || value === "removed";
}

function isLocalSandboxRetentionPolicyValue(value: unknown): value is LocalSandboxRetentionPolicy {
  return value === "active" || value === "ttl";
}

function compactSlug(parts: string[], maxLength: number, separator = "-"): string {
  const slug = parts.filter(Boolean).join(separator).replace(new RegExp(`${separator}+`, "g"), separator);
  if (slug.length <= maxLength) return slug;
  return slug.slice(0, maxLength).replace(new RegExp(`${separator}+$`), "");
}

function compactSlugWithHash(
  parts: string[],
  maxLength: number,
  hash: string,
  separator = "-",
): string {
  const suffix = `${separator}${hash}`;
  const baseMaxLength = Math.max(1, maxLength - suffix.length);
  const base = compactSlug(parts, baseMaxLength, separator);
  return `${base}${suffix}`;
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "sandbox"
  );
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

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function shouldPruneSandboxEntry(entry: LocalSandboxRegistryEntry, now: Date): boolean {
  if (!isTerminalExecutionState(entry.state)) {
    return false;
  }

  if (entry.retentionPolicy !== "ttl" || !entry.cleanupAfter) {
    return false;
  }

  return new Date(entry.cleanupAfter).getTime() <= now.getTime();
}

function isTerminalExecutionState(state: ExecutionState): state is "completed" | "failed" | "cancelled" {
  return state === "completed" || state === "failed" || state === "cancelled";
}

function resolveSandboxDirFromEntry(entry: LocalSandboxRegistryEntry): string {
  return entry.metadataPath ? dirname(entry.metadataPath) : dirname(entry.envPath);
}

async function copyDevcontainerDirectory(
  sourceDir: string,
  targetDir: string,
  excludedPaths: string[],
  relativeDir = DEVCONTAINER_DIR_NAME,
): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);
    const relativePath = join(relativeDir, entry.name);

    if (shouldExcludeDevcontainerPath(relativePath)) {
      excludedPaths.push(relativePath);
      continue;
    }

    if (entry.isDirectory()) {
      await copyDevcontainerDirectory(sourcePath, targetPath, excludedPaths, relativePath);
      continue;
    }

    if (entry.isSymbolicLink()) {
      const linkTarget = await readlink(sourcePath);
      await symlink(linkTarget, targetPath);
      continue;
    }

    await copyFile(sourcePath, targetPath);
  }
}

function shouldExcludeDevcontainerPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  const basename = normalized.split("/").pop()?.toLowerCase() || "";

  return (
    basename === ".sandbox.env" ||
    basename === ".env" ||
    basename.startsWith(".env.") ||
    basename.endsWith(".local") ||
    basename.includes("secret") ||
    /\.(pem|key|crt)$/i.test(basename)
  );
}
