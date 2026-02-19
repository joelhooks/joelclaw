import type { Metadata } from "next";
import { SITE_NAME } from "../../lib/constants";

type NodeStatus = "Online" | "Offline" | "Idle";

type NodeSpec = {
  name: string;
  tailscaleHost?: string;
  status: NodeStatus;
  specs: string[];
  role: string;
  services?: string[];
};

const clusterOverview = [
  { label: "Orchestration", value: "Talos Linux v1.12.4 on Colima (VZ framework)" },
  { label: "Memory", value: "64 GB unified" },
  { label: "CPU", value: "Apple M4 Pro · 14 cores" },
  { label: "GPU", value: "20-core Apple GPU" },
  { label: "Storage", value: "64 TB NAS + 1 TB local NVMe" },
  { label: "Functions", value: "48 Inngest durable functions" },
  { label: "Interconnect", value: "Tailscale WireGuard mesh" },
];

const nodes: NodeSpec[] = [
  {
    name: "Overlook",
    tailscaleHost: "overlook",
    status: "Online",
    specs: ["Mac Mini", "Apple M4 Pro", "14-core CPU", "20-core GPU", "64 GB unified", "1 TB NVMe"],
    role: "Control plane. Runs everything — k8s cluster, agent gateway, event bus, all pipelines. Always on, always watching.",
    services: [
      "Talos k8s cluster (Colima + Talos)",
      "Inngest event bus (k8s StatefulSet)",
      "Redis state/pub-sub (k8s StatefulSet)",
      "Qdrant vector search (k8s StatefulSet)",
      "Bluesky PDS — AT Protocol personal data server (Helm)",
      "LiveKit — WebRTC media server (Helm)",
      "System-bus worker (launchd, 48 functions)",
      "Gateway daemon (launchd, pi agent + Telegram bridge)",
      "Caddy HTTPS proxy (launchd, Tailscale TLS)",
      "Vault sync (launchd, git auto-commit + push)",
    ],
  },
  {
    name: "Derry",
    tailscaleHost: "derry",
    status: "Online",
    specs: ["NAS", "Intel Atom", "8 GB RAM", "64 TB RAID"],
    role: "Archive. Video library, book collection, media backups, pipeline output landing zone. Everything's buried down here.",
    services: [
      "SSH file access (video ingest target)",
      "Video archive by year (yt-dlp pipeline output)",
      "Screenshot storage (pipeline-extracted key moments)",
    ],
  },
  {
    name: "Flagg",
    tailscaleHost: "flagg",
    status: "Online",
    specs: ["MacBook Pro", "Apple Silicon", "macOS"],
    role: "Primary development machine. Goes everywhere, exit node for the tailnet.",
  },
  {
    name: "Blaine",
    tailscaleHost: "blaine",
    status: "Online",
    specs: ["Linux server"],
    role: "Remote Linux node. Available on tailnet. Asks a lot of riddles.",
  },
  {
    name: "Todash",
    tailscaleHost: "todash",
    status: "Idle",
    specs: ["Linux router"],
    role: "Network edge. Tailscale exit node, currently idle. The darkness between worlds.",
  },
];

const launchdServices = [
  { name: "system-bus-worker", desc: "Inngest function worker (48 functions)" },
  { name: "gateway", desc: "Pi agent gateway daemon + Telegram bridge" },
  { name: "gateway-tripwire", desc: "Gateway watchdog" },
  { name: "caddy", desc: "HTTPS reverse proxy with Tailscale certs" },
  { name: "colima", desc: "Container runtime (VZ framework → Talos k8s)" },
  { name: "vault-log-sync", desc: "system-log.jsonl → Obsidian markdown notes" },
  { name: "content-sync-watcher", desc: "Vault content → web deploy trigger" },
  { name: "system-bus-sync", desc: "Monorepo → worker clone sync" },
];

const k8sPods = [
  { name: "inngest-0", desc: "Event orchestration server" },
  { name: "redis-0", desc: "State, pub/sub, loop PRD, cooldowns" },
  { name: "qdrant-0", desc: "Vector search (memory observations)" },
  { name: "bluesky-pds", desc: "AT Protocol personal data server (Helm)" },
  { name: "livekit-server", desc: "WebRTC media server (Helm)" },
];

const architectureLayers = [
  "Layer 5: Agents       — Pi gateway, coding loops, background workers",
  "Layer 4: Orchestration — Talos k8s cluster, launchd daemons, Helm releases",
  "Layer 3: Services      — Inngest, Redis, Qdrant, PDS, LiveKit (k8s pods)",
  "Layer 2: Pipelines     — Video ingest, transcription, screenshots, content enrichment",
  "Layer 1: Memory        — Observations, proposals, MEMORY.md, session transcripts",
  "Layer 0: Data          — Obsidian Vault, system-log.jsonl, 64 TB NAS archive",
];

export const metadata: Metadata = {
  title: `Network — ${SITE_NAME}`,
  description:
    "The joelclaw network — Talos k8s on Apple Silicon with 48 Inngest functions, vector search, AT Protocol PDS, and 64TB archival storage.",
};

function StatusDot({ status }: { status: NodeStatus }) {
  const color =
    status === "Online"
      ? "bg-emerald-400"
      : status === "Idle"
        ? "bg-yellow-400"
        : "bg-neutral-600";

  return (
    <span className="relative flex h-2 w-2">
      {status === "Online" && (
        <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${color} opacity-40`} />
      )}
      <span className={`relative inline-flex h-2 w-2 rounded-full ${color}`} />
    </span>
  );
}

export default function NetworkPage() {
  return (
    <div className="space-y-12">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Network</h1>
        <p className="mt-2 text-sm text-neutral-400 leading-relaxed">
          Always-on personal infrastructure.{" "}
          <span className="text-claw">Overlook</span> runs the cluster, agents,
          and all pipelines.{" "}
          <span className="text-neutral-300">Derry</span> holds 64 TB of
          archive. Everything connected via encrypted WireGuard mesh.
        </p>
      </header>

      {/* Cluster overview */}
      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-widest text-neutral-500 font-medium">Cluster</h2>
        <div className="border border-neutral-800 rounded-lg p-5">
          <dl className="grid gap-4 sm:grid-cols-2">
            {clusterOverview.map((item) => (
              <div key={item.label} className="space-y-0.5">
                <dt className="text-[11px] uppercase tracking-wider text-neutral-600">{item.label}</dt>
                <dd className="font-mono text-sm text-neutral-200">{item.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* Nodes */}
      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-widest text-neutral-500 font-medium">Nodes</h2>
        <div className="space-y-3">
          {nodes.map((node) => (
            <article key={node.name} className="border border-neutral-800 rounded-lg p-5 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <StatusDot status={node.status} />
                  <h3 className="text-base font-semibold text-neutral-100">{node.name}</h3>
                  {node.tailscaleHost && (
                    <span className="font-mono text-xs text-neutral-600">{node.tailscaleHost}</span>
                  )}
                </div>
                <span className="text-[11px] text-neutral-600 uppercase tracking-wider">{node.status}</span>
              </div>

              <p className="text-sm text-neutral-400 leading-relaxed">{node.role}</p>

              <p className="font-mono text-xs text-neutral-500">{node.specs.join(" · ")}</p>

              {node.services && node.services.length > 0 && (
                <div className="pt-1">
                  <ul className="space-y-1">
                    {node.services.map((s) => (
                      <li key={s} className="text-sm text-neutral-400 flex items-start gap-2">
                        <span className="text-neutral-700 mt-1.5 text-[8px]">●</span>
                        {s}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </article>
          ))}
        </div>
      </section>

      {/* K8s Pods */}
      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-widest text-neutral-500 font-medium">
          K8s Pods <span className="text-neutral-700 normal-case tracking-normal">joelclaw namespace</span>
        </h2>
        <div className="border border-neutral-800 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-800 text-left">
                <th className="px-4 py-2.5 text-[11px] uppercase tracking-wider text-neutral-600 font-medium">Pod</th>
                <th className="px-4 py-2.5 text-[11px] uppercase tracking-wider text-neutral-600 font-medium">Role</th>
              </tr>
            </thead>
            <tbody>
              {k8sPods.map((pod) => (
                <tr key={pod.name} className="border-b border-neutral-800/50 last:border-0">
                  <td className="px-4 py-2.5 font-mono text-xs text-neutral-200">{pod.name}</td>
                  <td className="px-4 py-2.5 text-neutral-400">{pod.desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Launchd daemons */}
      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-widest text-neutral-500 font-medium">
          Daemons <span className="text-neutral-700 normal-case tracking-normal">launchd</span>
        </h2>
        <div className="border border-neutral-800 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-800 text-left">
                <th className="px-4 py-2.5 text-[11px] uppercase tracking-wider text-neutral-600 font-medium">Service</th>
                <th className="px-4 py-2.5 text-[11px] uppercase tracking-wider text-neutral-600 font-medium">Purpose</th>
              </tr>
            </thead>
            <tbody>
              {launchdServices.map((svc) => (
                <tr key={svc.name} className="border-b border-neutral-800/50 last:border-0">
                  <td className="px-4 py-2.5 font-mono text-xs text-neutral-200 whitespace-nowrap">{svc.name}</td>
                  <td className="px-4 py-2.5 text-neutral-400">{svc.desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Architecture layers */}
      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-widest text-neutral-500 font-medium">Stack</h2>
        <div className="border border-neutral-800 rounded-lg p-5">
          <pre className="font-mono text-xs leading-relaxed text-neutral-400 whitespace-pre-wrap">
            {architectureLayers.join("\n")}
          </pre>
        </div>
      </section>
    </div>
  );
}
