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
  { label: "Functions", value: "66 Inngest durable functions" },
  { label: "Skills", value: "65 agent skills" },
  { label: "Interconnect", value: "Tailscale WireGuard mesh" },
];

const nodes: NodeSpec[] = [
  {
    name: "Panda",
    tailscaleHost: "panda",
    status: "Online",
    specs: ["Mac Mini", "Apple M4 Pro", "14-core CPU", "20-core GPU", "64 GB unified", "1 TB NVMe"],
    role: "Control plane. Runs everything — k8s cluster, agent gateway, event bus, all pipelines. Always on, always watching.",
    services: [
      "Talos k8s cluster (Colima + Talos)",
      "Inngest event bus (k8s StatefulSet)",
      "Redis state/pub-sub (k8s StatefulSet)",
      "Typesense search (k8s StatefulSet, 6 collections)",
      "Qdrant vector search (k8s StatefulSet, migration target)",
      "Bluesky PDS — AT Protocol personal data server (Helm)",
      "LiveKit — WebRTC media server (Helm)",
      "System-bus worker (launchd, 66 functions)",
      "Gateway daemon (launchd, pi agent + Telegram bridge)",
      "Caddy HTTPS proxy (launchd, Tailscale TLS)",
      "Vault sync (launchd, git auto-commit + push)",
      "Content sync watcher (launchd, Vault → web deploy)",
    ],
  },
  {
    name: "Clanker-001",
    tailscaleHost: "clanker-001",
    status: "Online",
    specs: ["Ubuntu 24.04", "16 GB RAM", "309 GB disk", "Public IP"],
    role: "Library and SIP bridge. Hosts pdf-brain knowledge base and public-facing telephony endpoint for the voice agent.",
    services: [
      "pdf-brain-api :3847 (knowledge base)",
      "LiveKit SIP bridge :5060 (public telephony endpoint)",
      "SIP RTP range :10000-20000",
    ],
  },
  {
    name: "Three-Body",
    tailscaleHost: "three-body",
    status: "Online",
    specs: ["Synology NAS", "Intel Atom C3538", "8 GB RAM", "64 TB RAID"],
    role: "Cold storage. Video archive by year, book collection, media backups, pipeline output landing zone.",
    services: [
      "SSH file access (video ingest target)",
      "Video archive by year (yt-dlp pipeline output)",
      "Book collection (aa-book pipeline output)",
    ],
  },
  {
    name: "Dark-Wizard",
    tailscaleHost: "dark-wizard",
    status: "Online",
    specs: ["MacBook Pro", "Apple Silicon", "macOS"],
    role: "Joel's primary development machine. Goes everywhere, exit node for the tailnet.",
  },
  {
    name: "Nightmare-Router",
    tailscaleHost: "nightmare-router",
    status: "Idle",
    specs: ["Linux router"],
    role: "Network edge. Tailscale exit node, currently idle.",
  },
];

const launchdServices = [
  { name: "system-bus-worker", desc: "Inngest function worker (66 functions)" },
  { name: "gateway", desc: "Pi agent gateway daemon + Telegram bridge" },
  { name: "gateway-tripwire", desc: "Gateway watchdog (auto-restart on failure)" },
  { name: "caddy", desc: "HTTPS reverse proxy with Tailscale certs" },
  { name: "colima", desc: "Container runtime (VZ framework → Talos k8s)" },
  { name: "vault-log-sync", desc: "system-log.jsonl → Obsidian markdown notes" },
  { name: "content-sync-watcher", desc: "Vault content → web deploy trigger" },
  { name: "system-bus-sync", desc: "Monorepo → worker clone sync" },
  { name: "typesense-portforward", desc: "kubectl port-forward for Typesense :8108" },
];

const k8sPods = [
  { name: "inngest-0", desc: "Event orchestration server" },
  { name: "redis-0", desc: "State, pub/sub, loop PRD, cooldowns" },
  { name: "typesense-0", desc: "Search engine (6 collections, auto-embedding via ONNX)" },
  { name: "qdrant-0", desc: "Vector search (legacy, being replaced by Typesense)" },
  { name: "bluesky-pds", desc: "AT Protocol personal data server (Helm)" },
  { name: "livekit-server", desc: "WebRTC media server (Helm)" },
];

const architectureLayers = [
  "Layer 6: Interface     — joelclaw.com (Next.js + Convex), ⌘K search, vault browser",
  "Layer 5: Agents       — Pi gateway, coding loops, background workers, voice agent",
  "Layer 4: Orchestration — Talos k8s cluster, launchd daemons, Helm releases",
  "Layer 3: Services      — Inngest, Redis, Typesense, PDS, LiveKit (k8s pods)",
  "Layer 2: Pipelines     — Video ingest, transcription, content sync, friction fix",
  "Layer 1: Memory        — Observations, contentResources (Convex), MEMORY.md",
  "Layer 0: Data          — Obsidian Vault, system-log.jsonl, 64 TB NAS archive",
];

export const metadata: Metadata = {
  title: `Network — ${SITE_NAME}`,
  description:
    "The joelclaw network — Talos k8s on Apple Silicon with 66 Inngest functions, Typesense search, AT Protocol PDS, Convex real-time data, and 64TB archival storage.",
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
          <span className="text-claw">Panda</span> runs the cluster, agents,
          and all pipelines.{" "}
          <span className="text-neutral-300">Clanker-001</span> bridges telephony.{" "}
          <span className="text-neutral-300">Three-Body</span> holds 64 TB of
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
