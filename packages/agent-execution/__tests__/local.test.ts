import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultLocalSandboxRegistryPath,
  emptyLocalSandboxRegistry,
  ensureLocalSandboxLayout,
  generateLocalSandboxIdentity,
  isLocalSandboxDevcontainerStrategy,
  isLocalSandboxIdentity,
  isLocalSandboxMode,
  isLocalSandboxRegistryEntry,
  LOCAL_SANDBOX_DEVCONTAINER_STRATEGIES,
  LOCAL_SANDBOX_MODES,
  materializeLocalSandboxDevcontainer,
  materializeLocalSandboxEnv,
  pruneExpiredLocalSandboxes,
  readLocalSandboxRegistry,
  removeLocalSandboxLayout,
  removeLocalSandboxRegistryEntry,
  resolveLocalSandboxPaths,
  resolveLocalSandboxRetention,
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

  test("exports and validates supported devcontainer materialization strategies", () => {
    expect(LOCAL_SANDBOX_DEVCONTAINER_STRATEGIES).toEqual(["copy", "symlink"]);
    expect(isLocalSandboxDevcontainerStrategy("copy")).toBe(true);
    expect(isLocalSandboxDevcontainerStrategy("symlink")).toBe(true);
    expect(isLocalSandboxDevcontainerStrategy("bogus")).toBe(false);
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

  test("preserves unique sandbox identity when request IDs share the same prefix", () => {
    const first = generateLocalSandboxIdentity({
      workflowId: "adr0221-phase3-dogfood",
      requestId: "adr0221-p3-proof-a",
      storyId: "compose-collision-proof",
    });
    const second = generateLocalSandboxIdentity({
      workflowId: "adr0221-phase3-dogfood",
      requestId: "adr0221-p3-proof-b",
      storyId: "compose-collision-proof",
    });

    expect(first.sandboxId).not.toBe(second.sandboxId);
    expect(first.slug).not.toBe(second.slug);
    expect(first.composeProjectName).not.toBe(second.composeProjectName);
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
    expect(paths.metadataPath).toBe(join(paths.sandboxDir, "sandbox.json"));
    expect(paths.devcontainerPath).toBe(join(paths.repoDir, ".devcontainer"));
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

  test("resolves retention policy by terminal state", () => {
    const completed = resolveLocalSandboxRetention({
      state: "completed",
      updatedAt: "2026-03-09T00:00:00.000Z",
    });
    const failed = resolveLocalSandboxRetention({
      state: "failed",
      updatedAt: "2026-03-09T00:00:00.000Z",
    });
    const running = resolveLocalSandboxRetention({
      state: "running",
      updatedAt: "2026-03-09T00:00:00.000Z",
    });

    expect(completed.policy).toBe("ttl");
    expect(completed.cleanupAfter).toBe("2026-03-10T00:00:00.000Z");
    expect(failed.cleanupAfter).toBe("2026-03-12T00:00:00.000Z");
    expect(running.policy).toBe("active");
    expect(running.cleanupAfter).toBeUndefined();
  });

  test("registry supports read, upsert, remove, and TTL pruning", async () => {
    const identity = generateLocalSandboxIdentity({
      workflowId: "workflow-123",
      requestId: "req-abcdef123456",
      storyId: "story-registry",
    });
    const paths = resolveLocalSandboxPaths(identity, { rootDir: testDir });
    const now = new Date("2026-03-09T00:00:00.000Z").toISOString();

    expect(await readLocalSandboxRegistry(paths.registryPath)).toEqual(emptyLocalSandboxRegistry());

    await ensureLocalSandboxLayout(paths);
    await writeFile(paths.envPath, "COMPOSE_PROJECT_NAME=test\n", "utf8");

    const entry = {
      ...identity,
      mode: "minimal" as const,
      baseSha: "abc123def456",
      path: paths.sandboxDir,
      repoPath: paths.repoDir,
      envPath: paths.envPath,
      metadataPath: paths.metadataPath,
      state: "completed" as const,
      backend: "local" as const,
      createdAt: now,
      updatedAt: now,
      teardownState: "active" as const,
      retentionPolicy: "ttl" as const,
      cleanupAfter: "2026-03-09T01:00:00.000Z",
      cleanupReason: "test retention",
      devcontainerStrategy: "copy" as const,
    };

    const registry = await upsertLocalSandboxRegistryEntry(entry, paths.registryPath);
    expect(registry.entries).toHaveLength(1);
    expect(isLocalSandboxRegistryEntry(registry.entries[0])).toBe(true);

    const pruned = await pruneExpiredLocalSandboxes({
      registryPath: paths.registryPath,
      now: new Date("2026-03-09T02:00:00.000Z"),
    });
    expect(pruned.removedSandboxIds).toEqual([identity.sandboxId]);
    expect(pruned.registry.entries).toHaveLength(0);
    await expect(readFile(paths.envPath, "utf8")).rejects.toThrow();

    const removed = await removeLocalSandboxRegistryEntry(entry.requestId, paths.registryPath);
    expect(removed.entries).toHaveLength(0);
  });

  test("copy-first devcontainer materialization excludes env and secret junk", async () => {
    const sourceRepoDir = join(testDir, "source-repo");
    const targetRepoDir = join(testDir, "target-repo");

    await mkdir(join(sourceRepoDir, ".devcontainer", "nested"), { recursive: true });
    await writeFile(join(sourceRepoDir, ".devcontainer", "devcontainer.json"), '{"name":"sandbox"}\n', "utf8");
    await writeFile(join(sourceRepoDir, ".devcontainer", ".env"), "SHOULD_NOT_COPY=true\n", "utf8");
    await writeFile(join(sourceRepoDir, ".devcontainer", "secrets.env"), "SHOULD_NOT_COPY=true\n", "utf8");
    await writeFile(join(sourceRepoDir, ".devcontainer", "nested", "settings.json"), '{"editor":"zed"}\n', "utf8");

    const result = await materializeLocalSandboxDevcontainer({
      sourceRepoDir,
      targetRepoDir,
    });

    expect(result.strategy).toBe("copy");
    expect(result.materialized).toBe(true);
    expect(result.excludedPaths).toContain(join(".devcontainer", ".env"));
    expect(result.excludedPaths).toContain(join(".devcontainer", "secrets.env"));
    expect(await readFile(join(targetRepoDir, ".devcontainer", "devcontainer.json"), "utf8")).toContain(
      '"sandbox"',
    );
    expect(await readFile(join(targetRepoDir, ".devcontainer", "nested", "settings.json"), "utf8")).toContain(
      '"zed"',
    );
    await expect(readFile(join(targetRepoDir, ".devcontainer", ".env"), "utf8")).rejects.toThrow();
  });

  test("concurrent local sandboxes keep compose identity and copied devcontainer state isolated", async () => {
    const sourceRepoDir = join(testDir, "source-repo");
    await mkdir(join(sourceRepoDir, ".devcontainer"), { recursive: true });
    await writeFile(join(sourceRepoDir, ".devcontainer", "devcontainer.json"), '{"name":"shared"}\n', "utf8");

    const firstIdentity = generateLocalSandboxIdentity({
      workflowId: "adr0221-phase3-dogfood",
      requestId: "adr0221-p3-proof-a",
      storyId: "compose-collision-proof",
    });
    const secondIdentity = generateLocalSandboxIdentity({
      workflowId: "adr0221-phase3-dogfood",
      requestId: "adr0221-p3-proof-b",
      storyId: "compose-collision-proof",
    });

    const firstPaths = resolveLocalSandboxPaths(firstIdentity, { rootDir: testDir });
    const secondPaths = resolveLocalSandboxPaths(secondIdentity, { rootDir: testDir });

    await Promise.all([
      ensureLocalSandboxLayout(firstPaths),
      ensureLocalSandboxLayout(secondPaths),
      materializeLocalSandboxEnv({
        path: firstPaths.envPath,
        identity: firstIdentity,
        mode: "full",
        baseSha: "abc123",
      }),
      materializeLocalSandboxEnv({
        path: secondPaths.envPath,
        identity: secondIdentity,
        mode: "full",
        baseSha: "abc123",
      }),
      materializeLocalSandboxDevcontainer({
        sourceRepoDir,
        targetRepoDir: firstPaths.repoDir,
      }),
      materializeLocalSandboxDevcontainer({
        sourceRepoDir,
        targetRepoDir: secondPaths.repoDir,
      }),
    ]);

    expect(firstIdentity.composeProjectName).not.toBe(secondIdentity.composeProjectName);
    expect(firstPaths.sandboxDir).not.toBe(secondPaths.sandboxDir);

    await writeFile(join(firstPaths.devcontainerPath, "local-only.json"), '{"sandbox":"first"}\n', "utf8");
    await expect(readFile(join(secondPaths.devcontainerPath, "local-only.json"), "utf8")).rejects.toThrow();

    const firstEnv = await readFile(firstPaths.envPath, "utf8");
    const secondEnv = await readFile(secondPaths.envPath, "utf8");
    expect(firstEnv).toContain(`COMPOSE_PROJECT_NAME=${firstIdentity.composeProjectName}`);
    expect(secondEnv).toContain(`COMPOSE_PROJECT_NAME=${secondIdentity.composeProjectName}`);
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
      path: paths.sandboxDir,
      repoPath: paths.repoDir,
      envPath: paths.envPath,
      metadataPath: paths.metadataPath,
      state: "pending" as const,
      backend: "local" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      teardownState: "active" as const,
      retentionPolicy: "active" as const,
      devcontainerStrategy: "copy" as const,
    };
    expect(isLocalSandboxRegistryEntry(registryEntry)).toBe(true);

    await removeLocalSandboxLayout(paths);
    await expect(readFile(paths.envPath, "utf8")).rejects.toThrow();
  });
});
