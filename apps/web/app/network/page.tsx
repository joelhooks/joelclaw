import type { Metadata } from "next";
import { SITE_NAME } from "../../lib/constants";

type NodeStatus = "Active" | "Dormant";

type NodeSpec = {
  name: string;
  status: NodeStatus;
  specs: string[];
  role: string;
  services?: string[];
};

const clusterOverview = [
  { label: "Orchestration", value: "k3s (v1.33.6) via k3d" },
  { label: "Unified memory", value: "64 GB" },
  { label: "CPU cores", value: "14" },
  { label: "GPU compute", value: "20-core Apple GPU" },
  { label: "Storage", value: "64+ TB (NAS)" },
  { label: "Active nodes", value: "3" },
  { label: "Interconnect", value: "WireGuard mesh (Tailscale)" },
];

const nodes: NodeSpec[] = [
  {
    name: "Hub",
    status: "Active",
    specs: ["Apple M4 Pro", "14-core CPU", "20-core GPU", "64 GB unified memory"],
    role: "Control plane, event bus, vector search, state management — k3s single-node cluster",
    services: [
      "k3s control plane (k3d)",
      "Event orchestration (Inngest — k8s StatefulSet)",
      "Vector database (Qdrant — k8s StatefulSet)",
      "Cache/state (Redis — k8s StatefulSet)",
      "System-bus worker (14 Inngest functions)",
      "HTTPS proxy (Caddy + Tailscale TLS)",
    ],
  },
  {
    name: "Library",
    status: "Active",
    specs: ["Linux server"],
    role: "Knowledge base — 700 documents, 393k searchable chunks",
    services: ["Semantic search API", "Full-text search", "Hybrid retrieval"],
  },
  {
    name: "Archive",
    status: "Active",
    specs: ["Intel Atom", "8 GB RAM", "64 TB network-attached storage"],
    role: "Cold storage — video archive, books, backups, media",
  },
  {
    name: "Forge",
    status: "Dormant",
    specs: [
      "Linux workstation",
      "2x NVIDIA RTX PRO 4500 (Blackwell architecture)",
      "48 GB VRAM (24 GB x 2)",
      "~1600 FP4 TOPS combined",
    ],
    role: "CUDA inference server — not on the network yet",
  },
];

const architectureLayers = [
  "Layer 4: Orchestration — k3s cluster, declarative scheduling",
  "Layer 3: Services      — Inngest, Qdrant, Redis as k8s StatefulSets",
  "Layer 2: Pipelines     — Video ingest, content sync, coding loops, memory",
  "Layer 1: Agents        — AI coding assistants with full recall",
  "Layer 0: Data          — Vault, system log, sessions, 64 TB archive",
];

export const metadata: Metadata = {
  title: `Network — ${SITE_NAME}`,
  description:
    "The joelclaw network — k3s-orchestrated services on Apple Silicon with vector search, event bus, and 64TB archival storage.",
};

function StatusBadge({ status }: { status: NodeStatus }) {
  const className =
    status === "Active"
      ? "border-emerald-800 bg-emerald-950/60 text-emerald-300"
      : "border-neutral-700 bg-neutral-900 text-neutral-300";

  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${className}`}
    >
      {status}
    </span>
  );
}

export default function NetworkPage() {
  return (
    <div className="space-y-10">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Network</h1>
        <p className="mt-2 text-sm text-neutral-400 leading-relaxed">
          The <span className="text-claw">joelclaw network</span> — services
          orchestrated by k3s on Apple Silicon, connected to a Linux knowledge
          base and 64TB of archival storage via encrypted WireGuard mesh.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-neutral-100">Cluster</h2>
        <div className="border border-neutral-800 rounded-lg p-4">
          <dl className="grid gap-3 sm:grid-cols-2">
            {clusterOverview.map((item) => (
              <div key={item.label} className="space-y-1">
                <dt className="text-xs uppercase tracking-wider text-neutral-500">{item.label}</dt>
                <dd className="font-mono text-sm text-neutral-100">{item.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-neutral-100">Nodes</h2>
        <div className="space-y-3">
          {nodes.map((node) => (
            <article key={node.name} className="border border-neutral-800 rounded-lg p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <h3 className="text-base font-semibold text-neutral-100">{node.name}</h3>
                <StatusBadge status={node.status} />
              </div>

              <p className="text-sm text-neutral-400 leading-relaxed">{node.role}</p>

              <p className="font-mono text-xs text-neutral-300">{node.specs.join(" • ")}</p>

              {node.services && node.services.length > 0 && (
                <div>
                  <p className="text-xs uppercase tracking-wider text-neutral-500">Services</p>
                  <p className="mt-1 text-sm text-neutral-400">{node.services.join(" • ")}</p>
                </div>
              )}
            </article>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-neutral-100">Stack</h2>
        <div className="border border-neutral-800 rounded-lg p-4">
          <pre className="font-mono text-xs leading-relaxed text-neutral-300 whitespace-pre-wrap">
            {architectureLayers.join("\n")}
          </pre>
        </div>
      </section>
    </div>
  );
}
