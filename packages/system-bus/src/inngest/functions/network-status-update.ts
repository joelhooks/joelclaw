import { execSync } from "node:child_process";
import { anyApi, type FunctionReference } from "convex/server";
import { getConvexClient, pushContentResource, removeContentResources } from "../../lib/convex";
import { inngest } from "../client";

type ResourceDoc = {
  resourceId: string;
  fields?: Record<string, unknown>;
};

type PodStatusRow = {
  name: string;
  status: string;
  restarts: number;
  age: string;
};

type LaunchdRow = {
  pid: number;
  exitStatus: number;
  label: string;
};

const KNOWN_DAEMONS = [
  "agent-secrets",
  "system-bus-worker",
  "gateway",
  "gateway-tripwire",
  "caddy",
  "colima",
  "vault-log-sync",
  "content-sync-watcher",
  "typesense-portforward",
] as const;

const DEFAULT_DAEMON_DESCRIPTIONS: Record<string, string> = {
  "agent-secrets": "Encrypted secrets daemon (leases API keys/tokens)",
  "system-bus-worker": "Inngest function worker (66 functions)",
  gateway: "Pi agent gateway daemon + Telegram bridge",
  "gateway-tripwire": "Gateway watchdog (auto-restart on failure)",
  caddy: "HTTPS reverse proxy with Tailscale certs",
  colima: "Container runtime (VZ framework → Talos k8s)",
  "vault-log-sync": "system-log.jsonl → Obsidian markdown notes",
  "content-sync-watcher": "Vault content → web deploy trigger",
  "typesense-portforward": "kubectl port-forward for Typesense :8108",
};

function runCommand(command: string): string {
  return execSync(command, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  }).trim();
}

async function listByType(type: string): Promise<ResourceDoc[]> {
  const client = getConvexClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ref = (anyApi as any).contentResources.listByType as FunctionReference<"query">;
  const docs = await client.query(ref, { type, limit: 500 });
  return Array.isArray(docs) ? (docs as ResourceDoc[]) : [];
}

function parsePods(raw: string): PodStatusRow[] {
  if (!raw) return [];

  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/);
      const [name, status, restartsRaw, ...ageParts] = parts;
      const restarts = Number.parseInt(restartsRaw ?? "0", 10);
      return {
        name: name ?? "",
        status: status ?? "Unknown",
        restarts: Number.isFinite(restarts) ? restarts : 0,
        age: ageParts.join(" "),
      };
    })
    .filter((row) => row.name.length > 0);
}

function parseLaunchctlRows(raw: string): LaunchdRow[] {
  if (!raw) return [];

  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/))
    .filter((parts) => parts.length >= 3)
    .map((parts) => {
      const pidRaw = parts[0] ?? "-1";
      const statusRaw = parts[1] ?? "-1";
      const label = parts.slice(2).join(" ");
      const pid = pidRaw === "-" ? -1 : Number.parseInt(pidRaw, 10);
      const exitStatus = Number.parseInt(statusRaw, 10);
      return {
        pid: Number.isFinite(pid) ? pid : -1,
        exitStatus: Number.isFinite(exitStatus) ? exitStatus : -1,
        label,
      };
    });
}

function normalizeDaemonStatus(row: LaunchdRow | undefined): string {
  // ADR-0085: PID > 0 is running; otherwise infer idle/stopped from last exit status.
  if (!row) return "offline";
  if (row.pid > 0) return "running";
  if (row.pid === 0 || row.pid === -1) {
    return row.exitStatus === 0 ? "idle" : "stopped";
  }
  return "offline";
}

function parseFunctionsCountFromWorkerApi(raw: string): number {
  try {
    const data = JSON.parse(raw) as {
      count?: unknown;
      worker?: {
        roleCounts?: {
          active?: unknown;
        };
      };
    };
    const count = typeof data.count === "number"
      ? data.count
      : (typeof data.worker?.roleCounts?.active === "number" ? data.worker.roleCounts.active : 0);
    return Number.isFinite(count) ? count : 0;
  } catch {
    return 0;
  }
}

function getSkillsCount(): number {
  try {
    const home = process.env.HOME || "/Users/joel";
    const output = runCommand(`ls -1 ${JSON.stringify(`${home}/.agents/skills`)} | wc -l`);
    const count = Number.parseInt(output.trim(), 10);
    return Number.isFinite(count) ? count : 0;
  } catch {
    return 0;
  }
}

export const networkStatusUpdate = inngest.createFunction(
  { id: "network/status-update", retries: 1, concurrency: { limit: 1 } },
  { event: "system/network.update" },
  async ({ step }) => {
    // ADR-0085: collect-pod-status
    await step.run("collect-pod-status", async () => {
      const podsOutput = runCommand(
        "kubectl get pods -n joelclaw --no-headers -o custom-columns=NAME:.metadata.name,STATUS:.status.phase,RESTARTS:.status.containerStatuses[0].restartCount,AGE:.metadata.creationTimestamp"
      );
      const rows = parsePods(podsOutput);
      const existing = await listByType("network_pod");
      const descriptionByName = new Map<string, string>();
      const currentPodResourceIds = new Set(rows.map((row) => `pod:${row.name}`));

      for (const doc of existing) {
        const name = typeof doc.fields?.name === "string" ? doc.fields.name : doc.resourceId.replace(/^pod:/, "");
        const description = typeof doc.fields?.description === "string" ? doc.fields.description : "";
        if (name) descriptionByName.set(name, description);
      }

      const staleResourceIds = existing
        .map((doc) => doc.resourceId)
        .filter((resourceId) => resourceId.startsWith("pod:") && !currentPodResourceIds.has(resourceId));
      await removeContentResources(staleResourceIds);

      for (const row of rows) {
        await pushContentResource(`pod:${row.name}`, "network_pod", {
          name: row.name,
          status: row.status,
          namespace: "joelclaw",
          description: descriptionByName.get(row.name) ?? "",
          restarts: row.restarts,
          age: row.age,
        });
      }

      return { pods: rows.length };
    });

    // ADR-0085: collect-daemon-status
    await step.run("collect-daemon-status", async () => {
      const launchRaw = runCommand("launchctl list | grep com.joel || true");
      const rows = parseLaunchctlRows(launchRaw);

      const rowByDaemon = new Map<string, LaunchdRow>();
      for (const row of rows) {
        const clean = row.label.replace(/^com\.joel\./, "");
        rowByDaemon.set(clean, row);
      }

      const existing = await listByType("network_daemon");
      const descriptionByName = new Map<string, string>();
      for (const doc of existing) {
        const name = typeof doc.fields?.name === "string" ? doc.fields.name : doc.resourceId.replace(/^daemon:/, "");
        const description = typeof doc.fields?.description === "string" ? doc.fields.description : "";
        if (name) descriptionByName.set(name, description);
      }

      for (const daemonName of KNOWN_DAEMONS) {
        const status = normalizeDaemonStatus(rowByDaemon.get(daemonName));
        await pushContentResource(`daemon:${daemonName}`, "network_daemon", {
          name: daemonName,
          status,
          description: descriptionByName.get(daemonName) ?? DEFAULT_DAEMON_DESCRIPTIONS[daemonName] ?? "",
        });
      }

      return { daemons: KNOWN_DAEMONS.length };
    });

    // ADR-0085: collect-tailscale-status
    await step.run("collect-tailscale-status", async () => {
      const tailscaleRaw = runCommand("tailscale status || true");
      const tailscaleLines = tailscaleRaw.toLowerCase().split("\n");
      const nodes = await listByType("network_node");

      for (const node of nodes) {
        const fields = node.fields ?? {};
        const publicName = typeof fields.publicName === "string" ? fields.publicName : node.resourceId.replace(/^node:/, "");
        const privateName = typeof fields.privateName === "string" ? fields.privateName : "";
        const privateNameLower = privateName.toLowerCase();

        let status = typeof fields.status === "string" ? fields.status : "Offline";
        const line = tailscaleLines.find((candidate) => privateNameLower && candidate.includes(privateNameLower));

        if (line) {
          if (line.includes("offline")) {
            status = "Offline";
          } else if (line.includes("idle")) {
            status = "Idle";
          } else {
            status = "Online";
          }
        }

        await pushContentResource(`node:${publicName}`, "network_node", {
          publicName,
          privateName,
          status,
          specs: Array.isArray(fields.specs) ? fields.specs : [],
          role: typeof fields.role === "string" ? fields.role : "",
          services: Array.isArray(fields.services) ? fields.services : [],
        });
      }

      return { nodes: nodes.length };
    });

    // ADR-0085: collect-counts
    await step.run("collect-counts", async () => {
      let functionCount = 0;

      try {
        const apiJson = runCommand("curl -s http://localhost:3111/");
        functionCount = parseFunctionsCountFromWorkerApi(apiJson);
      } catch {
        functionCount = 0;
      }

      const skillsCount = getSkillsCount();

      await pushContentResource("cluster:Functions", "network_cluster", {
        key: "Functions",
        value: `${functionCount} Inngest durable functions`,
      });

      await pushContentResource("cluster:Skills", "network_cluster", {
        key: "Skills",
        value: `${skillsCount} agent skills`,
      });

      return { functionCount, skillsCount };
    });

    return { ok: true };
  }
);
