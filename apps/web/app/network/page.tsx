import type { Metadata } from "next";
import { SITE_NAME } from "../../lib/constants";

type NodeStatus = "Active" | "Planned" | "Dormant";

type NodeSpec = {
  name: string;
  status: NodeStatus;
  specs: string[];
  role: string;
  services?: string[];
};

const clusterOverview = [
  { label: "Total unified memory", value: "192+ GB" },
  { label: "Total VRAM", value: "48 GB" },
  { label: "CPU cores", value: "30+" },
  {
    label: "GPU compute",
    value: "60-core Apple GPU + dual Blackwell (~1600 FP4 TOPS)",
  },
  { label: "Storage", value: "64+ TB" },
  { label: "Nodes", value: "5 (2 active, 3 planned/dormant)" },
  { label: "Interconnect", value: "WireGuard mesh + Thunderbolt 5 RDMA" },
];

const nodes: NodeSpec[] = [
  {
    name: "Hub",
    status: "Active",
    specs: ["Apple M4 Pro", "14-core CPU", "20-core GPU", "64 GB unified memory"],
    role: "Control plane, event bus, vector search, state management",
    services: [
      "Event orchestration (Inngest)",
      "Vector database (Qdrant)",
      "Cache/state (Redis)",
      "HTTPS proxy",
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
    name: "Studio",
    status: "Planned",
    specs: [
      "Apple M4 Max",
      "16-core CPU",
      "40-core GPU",
      "16-core Neural Engine",
      "128 GB unified memory",
      "2 TB SSD",
      "10 Gb Ethernet",
      "Thunderbolt 5",
    ],
    role: "Primary compute hub — local LLM inference (70B-235B models), GPU-accelerated embedding, tensor parallel with Hub via TB5 RDMA",
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
    role: "CUDA inference server — high-throughput batch processing, embedding at GPU speed, video transcription",
  },
];

const architectureLayers = [
  "Layer 5: Inference     — Local LLMs (exo + vLLM), 192 GB unified + 48 GB VRAM",
  "Layer 4: Orchestration — k3s cluster, declarative scheduling across nodes",
  "Layer 3: Services      — Event bus, vector search, cache, observability",
  "Layer 2: Pipelines     — Memory extraction, session indexing, taxonomy sync",
  "Layer 1: Agents        — AI coding assistants with full recall + local inference",
  "Layer 0: Data          — Vault, system log, sessions, 64 TB archive, SKOS taxonomy",
];

export const metadata: Metadata = {
  title: `Network — ${SITE_NAME}`,
  description:
    "The joelclaw network — nodes, capabilities, and architecture across local AI compute and storage.",
};

function StatusBadge({ status }: { status: NodeStatus }) {
  const className =
    status === "Active"
      ? "border-emerald-800 bg-emerald-950/60 text-emerald-300"
      : status === "Planned"
        ? "border-amber-800 bg-amber-950/60 text-amber-300"
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
          The <span className="text-claw">joelclaw network</span> — a personal AI
          compute fabric spanning Apple Silicon, NVIDIA Blackwell, and 64TB of
          archival storage. Orchestrated by Inngest, connected via encrypted mesh.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-neutral-100">Cluster Overview</h2>
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
        <h2 className="text-lg font-semibold tracking-tight text-neutral-100">Architecture Layers</h2>
        <div className="border border-neutral-800 rounded-lg p-4">
          <pre className="font-mono text-xs leading-relaxed text-neutral-300 whitespace-pre-wrap">
            {architectureLayers.join("\n")}
          </pre>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-neutral-100">Interconnect</h2>
        <div className="border border-neutral-800 rounded-lg p-4">
          <p className="text-sm text-neutral-400 leading-relaxed">
            An encrypted WireGuard mesh connects all nodes. Thunderbolt 5 RDMA
            links Apple Silicon nodes for tensor-parallel inference. All traffic
            is encrypted end-to-end.
          </p>
        </div>
      </section>
    </div>
  );
}

