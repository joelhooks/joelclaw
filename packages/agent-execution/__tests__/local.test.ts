import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultLocalSandboxRegistryPath,
  emptyLocalSandboxRegistry,
  ensureLocalSandboxLayout,
  generateLocalSandboxIdentity,
  isLocalSandboxIdentity,
  isLocalSandboxMode,
  isLocalSandboxRegistryEntry,
  LOCAL_SANDBOX_MODES,
  materializeLocalSandboxEnv,
  readLocalSandboxRegistry,
  removeLocalSandboxLayout,
  removeLocalSandboxRegistryEntry,
  resolveLocalSandboxPaths,
  upsertLocalSandboxRegistryEntry,
} from "../src/index.js";

describe("local sandbox primitives", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "agent-execution-local-"));
  });

  afterEach(async () => {
    if (testDir) {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test("exports and validates supported local sandbox modes", () => {
    expect(LOCAL_SANDBOX_MODES).toEqual(["minimal", "full"]);
    expect(isLocalSandboxMode("minimal")).toBe(true);
    expect(isLocalSandboxMode("full")).toBe(true);
    expect(isLocalSandboxMode("bogus")).toBe(false);
  });

  test("generates deterministic sandbox identity", () => {
    const input = {
      workflowId: "WL_20260309_230352",
      requestId: "req-1234567890abcdef",
      storyId: "story-identity",
    };

    const first = generateLocalSandboxIdentity(input);
    const second = generateLocalSandboxIdentity(input);

    expect(first).toEqual(second);
    expect(first.composeProjectName.startsWith("jc_")).toBe(true);
    expect(first.composeProjectName.length).toBeLessThanOrEqual(40);
    expect(first.slug.length).toBeLessThanOrEqual(48);
    expect(isLocalSandboxIdentity(first)).toBe(true);
  });

  test("resolves deterministic sandbox paths under provided root", () => {
    const identity = generateLocalSandboxIdentity({
      workflowId: "workflow-123",
      requestId: "req-abcdef123456",
      storyId: "story-paths",
    });

    const paths = resolveLocalSandboxPaths(identity, { rootDir: testDir });

    expect(paths.rootDir).toBe(testDir);
    expect(paths.sandboxDir).toContain(identity.sandboxId);
    expect(paths.repoDir).toBe(join(paths.sandboxDir, "repo"));
    expect(paths.envPath).toBe(join(paths.sandboxDir, ".sandbox.env"));
    expect(paths.registryPath).toBe(defaultLocalSandboxRegistryPath(testDir));
  });

  test("materializes per-sandbox env file with sorted, sanitized values", async () => {
    const identity = generateLocalSandboxIdentity({
      workflowId: "workflow-123",
      requestId: "req-abcdef123456",
      storyId: "story-env",
    });
    const paths = resolveLocalSandboxPaths(identity, { rootDir: testDir });

    await ensureLocalSandboxLayout(paths);
    const result = await materializeLocalSandboxEnv({
      path: paths.envPath,
      identity,
      mode: "minimal",
      baseSha: "abc123def456",
      extra: {
        APP_URL: "http://localhost:3000",
        MULTILINE: "line1\nline2",
      },
    });

    expect(result.values.COMPOSE_PROJECT_NAME).toBe(identity.composeProjectName);
    expect(result.values.JOELCLAW_SANDBOX_MODE).toBe("minimal");
    expect(result.values.MULTILINE).toBe("line1 line2");

    const written = await readFile(paths.envPath, "utf8");
    expect(written).toBe(result.content);
    expect(written.includes(`COMPOSE_PROJECT_NAME=${identity.composeProjectName}`)).toBe(true);
    expect(written.includes('MULTILINE="line1 line2"')).toBe(true);
  });

  test("registry supports read, upsert, and remove", async () => {
    const identity = generateLocalSandboxIdentity({
      workflowId: "workflow-123",
      requestId: "req-abcdef123456",
      storyId: "story-registry",
    });
    const paths = resolveLocalSandboxPaths(identity, { rootDir: testDir });
    const now = new Date().toISOString();

    expect(await readLocalSandboxRegistry(paths.registryPath)).toEqual(emptyLocalSandboxRegistry());

    const entry = {
      ...identity,
      mode: "minimal" as const,
      baseSha: "abc123def456",
      path: paths.repoDir,
      envPath: paths.envPath,
      state: "pending" as const,
      backend: "local" as const,
      createdAt: now,
      updatedAt: now,
      teardownState: "active" as const,
    };

    const registry = await upsertLocalSandboxRegistryEntry(entry, paths.registryPath);
    expect(registry.entries).toHaveLength(1);
    expect(isLocalSandboxRegistryEntry(registry.entries[0])).toBe(true);

    const updated = await upsertLocalSandboxRegistryEntry(
      {
        ...entry,
        state: "running",
        updatedAt: new Date(Date.now() + 1_000).toISOString(),
      },
      paths.registryPath,
    );
    expect(updated.entries).toHaveLength(1);
    expect(updated.entries[0]?.state).toBe("running");

    const removed = await removeLocalSandboxRegistryEntry(entry.requestId, paths.registryPath);
    expect(removed.entries).toHaveLength(0);
  });

  test("layout helpers create and remove sandbox directories", async () => {
    const identity = generateLocalSandboxIdentity({
      workflowId: "workflow-123",
      requestId: "req-abcdef123456",
      storyId: "story-layout",
    });
    const paths = resolveLocalSandboxPaths(identity, { rootDir: testDir });

    await ensureLocalSandboxLayout(paths);
    const registryEntry = {
      ...identity,
      mode: "full" as const,
      baseSha: "abc123def456",
      path: paths.repoDir,
      envPath: paths.envPath,
      state: "pending" as const,
      backend: "local" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      teardownState: "active" as const,
    };
    expect(isLocalSandboxRegistryEntry(registryEntry)).toBe(true);

    await removeLocalSandboxLayout(paths);
    await expect(readFile(paths.envPath, "utf8")).rejects.toThrow();
  });
});
