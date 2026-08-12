import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { SlackChannelContextBinding } from "./slack-work-request";

export type SlackProjectCandidate = {
  readonly id: string;
  readonly label: string;
  readonly root: string;
  readonly source: "channel" | "binding" | "active-work";
  readonly binding: SlackChannelContextBinding;
};

type SlackContextsFile = {
  readonly channels?: Readonly<Record<string, SlackChannelContextBinding>>;
};

type WorkerRegistry = Readonly<Record<string, {
  readonly cwd?: string;
  readonly sourceCwd?: string;
  readonly label?: string | null;
  readonly dispatchedAt?: number;
}>>;

const DEFAULT_CONTEXTS_PATH = resolve(
  homedir(),
  ".joelclaw/slack-channel-contexts.json",
);
const DEFAULT_WORKERS_PATH = "/tmp/joelclaw/gateway-workers/lanes.json";

function slug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  return normalized || "project";
}

function rootOf(binding: SlackChannelContextBinding): string | undefined {
  return binding.cwd?.trim() || binding.repo?.trim();
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

async function verify(
  binding: SlackChannelContextBinding,
): Promise<SlackChannelContextBinding | undefined> {
  const root = rootOf(binding);
  if (!root || !isAbsolute(root)) return undefined;
  try {
    if (!(await stat(root)).isDirectory()) return undefined;
    if (binding.brainEntry) await stat(resolve(root, binding.brainEntry));
    return {
      ...binding,
      repo: binding.repo ?? root,
      cwd: binding.cwd ?? root,
    };
  } catch {
    return undefined;
  }
}

export async function loadSlackProjectCandidates(input: {
  readonly channelName: string;
  readonly currentBinding?: SlackChannelContextBinding;
  readonly contextsPath?: string;
  readonly workersPath?: string;
  readonly now?: number;
  readonly activeWorkMaxAgeMs?: number;
}): Promise<SlackProjectCandidate[]> {
  const contexts = await readJson<SlackContextsFile>(
    input.contextsPath ?? process.env.SLACK_SHITRAT_CONTEXTS_PATH?.trim() ?? DEFAULT_CONTEXTS_PATH,
    {},
  );
  const workers = await readJson<WorkerRegistry>(
    input.workersPath ?? DEFAULT_WORKERS_PATH,
    {},
  );
  const normalizedChannel = input.channelName.trim().toLowerCase().replace(/^#/u, "");
  const rows: Array<{
    label: string;
    source: SlackProjectCandidate["source"];
    binding: SlackChannelContextBinding;
  }> = [];

  if (input.currentBinding) {
    rows.push({ label: normalizedChannel, source: "channel", binding: input.currentBinding });
  }
  for (const [channel, binding] of Object.entries(contexts.channels ?? {})) {
    rows.push({
      label: channel,
      source: channel === normalizedChannel ? "channel" : "binding",
      binding,
    });
  }

  const now = input.now ?? Date.now();
  const maxAge = input.activeWorkMaxAgeMs ?? 7 * 24 * 60 * 60_000;
  for (const [lane, worker] of Object.entries(workers)) {
    const age = typeof worker.dispatchedAt === "number"
      ? now - worker.dispatchedAt
      : Number.NaN;
    if (!Number.isFinite(age) || age < 0 || age > maxAge) continue;
    const root = worker.sourceCwd?.trim() || worker.cwd?.trim();
    if (!root) continue;
    rows.push({
      label: worker.label?.trim() || lane,
      source: "active-work",
      binding: { repo: root, cwd: root },
    });
  }

  const candidates: SlackProjectCandidate[] = [];
  const roots = new Set<string>();
  for (const row of rows) {
    const binding = await verify(row.binding);
    const root = binding && rootOf(binding);
    if (!binding || !root || roots.has(root)) continue;
    roots.add(root);
    candidates.push({
      id: `${slug(row.label)}-${slug(root.split("/").at(-1) ?? "project")}`,
      label: row.label,
      root,
      source: row.source,
      binding,
    });
  }
  return candidates;
}
