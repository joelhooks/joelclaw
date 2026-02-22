import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AutoFixHandler } from "./index";

const RESTART_STAMP_PATH = "/tmp/joelclaw/o11y-restart-worker.last";
const RESTART_COOLDOWN_MS = Number.parseInt(
  process.env.O11Y_RESTART_COOLDOWN_MS ?? "600000",
  10
);
const INNGEST_BASE_URL = process.env.INNGEST_BASE_URL ?? "http://localhost:8288";
const ACTIVE_RUN_LOOKBACK_MINUTES = Number.parseInt(
  process.env.O11Y_RESTART_ACTIVE_LOOKBACK_MINUTES ?? "240",
  10
);
const ACTIVE_RUN_SCAN_LIMIT = Number.parseInt(
  process.env.O11Y_RESTART_ACTIVE_SCAN_LIMIT ?? "250",
  10
);

type RecentRunNode = {
  id: string;
  status: string;
  function?: { name?: string | null; slug?: string | null } | null;
};

function trimOutput(output: unknown): string {
  if (typeof output === "string") return output.trim();
  if (output == null) return "";
  return String(output).trim();
}

function readLastRestartMs(): number | null {
  try {
    const raw = readFileSync(RESTART_STAMP_PATH, "utf8").trim();
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeLastRestartMs(value: number): void {
  try {
    mkdirSync(dirname(RESTART_STAMP_PATH), { recursive: true });
    writeFileSync(RESTART_STAMP_PATH, String(value), "utf8");
  } catch {
    // best-effort; cooldown stamp is advisory
  }
}

function formatMs(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes}m`;
}

function formatSampleRuns(runs: RecentRunNode[]): string {
  if (runs.length === 0) return "";
  return runs
    .slice(0, 3)
    .map((run) => {
      const name = run.function?.name?.trim();
      const runName = name && name.length > 0 ? name : "unknown";
      return `${runName}:${run.id.slice(0, 12)}`;
    })
    .join(", ");
}

function lookbackFromIso(minutes: number): string {
  const safeMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : 240;
  return new Date(Date.now() - safeMinutes * 60 * 1000).toISOString();
}

async function loadRecentActiveRuns(): Promise<RecentRunNode[]> {
  const fromIso = lookbackFromIso(ACTIVE_RUN_LOOKBACK_MINUTES);
  const first =
    Number.isFinite(ACTIVE_RUN_SCAN_LIMIT) && ACTIVE_RUN_SCAN_LIMIT > 0
      ? Math.min(ACTIVE_RUN_SCAN_LIMIT, 1000)
      : 250;

  const query = `
    query {
      runs(
        first: ${first}
        orderBy: [{ field: STARTED_AT, direction: DESC }]
        filter: { from: \"${fromIso}\" }
      ) {
        edges {
          node {
            id
            status
            function {
              name
              slug
            }
          }
        }
      }
    }
  `;

  const res = await fetch(`${INNGEST_BASE_URL}/v0/gql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });

  if (!res.ok) {
    throw new Error(`active-run probe failed: HTTP ${res.status}`);
  }

  const json = (await res.json()) as {
    errors?: Array<{ message?: string }>;
    data?: {
      runs?: {
        edges?: Array<{
          node?: RecentRunNode | null;
        }>;
      };
    };
  };

  if (json.errors?.length) {
    throw new Error(
      `active-run probe failed: ${json.errors
        .map((error) => error.message ?? "unknown error")
        .join("; ")}`
    );
  }

  const edges = json.data?.runs?.edges ?? [];
  const active: RecentRunNode[] = [];
  for (const edge of edges) {
    const node = edge.node;
    if (!node) continue;
    if (node.status !== "RUNNING" && node.status !== "QUEUED") continue;

    const slug = node.function?.slug?.trim() ?? "";
    const isLegacyArchivedSlug =
      slug.startsWith("system-bus-") && !slug.startsWith("system-bus-host-");
    if (isLegacyArchivedSlug) continue;

    active.push(node);
  }

  return active;
}

export const restartWorker: AutoFixHandler = async () => {
  try {
    const activeRuns = await loadRecentActiveRuns();
    if (activeRuns.length > 0) {
      const sample = formatSampleRuns(activeRuns);
      return {
        fixed: true,
        detail:
          sample.length > 0
            ? `restart skipped: ${activeRuns.length} active runs (${sample})`
            : `restart skipped: ${activeRuns.length} active runs`,
      };
    }

    if (RESTART_COOLDOWN_MS > 0) {
      const now = Date.now();
      const lastRestartMs = readLastRestartMs();
      if (lastRestartMs != null) {
        const elapsed = now - lastRestartMs;
        const remaining = RESTART_COOLDOWN_MS - elapsed;
        if (remaining > 0) {
          return {
            fixed: true,
            detail: `restart suppressed by cooldown (${formatMs(remaining)} remaining)`,
          };
        }
      }
    }

    const restart = await Bun.$`launchctl kickstart -k gui/$(id -u)/com.joel.system-bus-worker`
      .quiet()
      .nothrow();
    if (restart.exitCode !== 0) {
      const stderr = trimOutput(restart.stderr);
      return {
        fixed: false,
        detail: stderr.length > 0 ? `restart failed: ${stderr}` : `restart failed (exit ${restart.exitCode})`,
      };
    }

    // Stamp immediately after a successful kickstart command.
    // Even if subsequent health probing fails, this prevents rapid restart thrash.
    writeLastRestartMs(Date.now());

    await Bun.sleep(5000);

    const health = await Bun.$`curl -fsS -m 5 http://127.0.0.1:3111/`.quiet().nothrow();
    if (health.exitCode !== 0) {
      const stderr = trimOutput(health.stderr);
      return {
        fixed: false,
        detail:
          stderr.length > 0
            ? `restart issued but health probe failed: ${stderr}`
            : `restart issued but health probe failed (exit ${health.exitCode})`,
      };
    }

    const body = trimOutput(health.stdout);
    if (body.length === 0) {
      return {
        fixed: false,
        detail: "restart issued but health probe returned empty response",
      };
    }

    return {
      fixed: true,
      detail: "worker restarted and health endpoint responded",
    };
  } catch (error) {
    return {
      fixed: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
};
