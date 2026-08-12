import { afterEach, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSlackProjectCandidates } from "./slack-project-candidates";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("project candidates come only from verified bindings and recent active work", async () => {
  const root = join(tmpdir(), `slack-candidates-${crypto.randomUUID()}`);
  const repoA = join(root, "alpha");
  const repoB = join(root, "bravo");
  roots.push(root);
  await Promise.all([mkdir(repoA, { recursive: true }), mkdir(repoB, { recursive: true })]);
  const contextsPath = join(root, "contexts.json");
  const workersPath = join(root, "workers.json");
  await writeFile(contextsPath, JSON.stringify({
    version: 1,
    channels: {
      "lc-alpha": { cwd: repoA },
      "cc-broken": { cwd: join(root, "missing") },
    },
  }));
  await writeFile(workersPath, JSON.stringify({
    "recent-bravo": {
      sourceCwd: repoB,
      label: "Bravo work",
      dispatchedAt: 1_000,
    },
    "stale-alpha": {
      sourceCwd: repoA,
      dispatchedAt: 1,
    },
  }));

  const candidates = await loadSlackProjectCandidates({
    channelName: "lc-alpha",
    contextsPath,
    workersPath,
    now: 2_000,
    activeWorkMaxAgeMs: 1_500,
  });

  expect(candidates.map(({ root: candidateRoot, source }) => ({
    root: candidateRoot,
    source,
  }))).toEqual([
    { root: repoA, source: "channel" },
    { root: repoB, source: "active-work" },
  ]);
});
