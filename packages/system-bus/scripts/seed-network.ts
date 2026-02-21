import { pushContentResource } from "../src/lib/convex";

// ADR-0085: One-time seed for data-driven network page contentResources.
async function seedNetwork(): Promise<void> {
  const nodes = [
    {
      publicName: "Overlook",
      privateName: "panda",
      status: "Online",
      specs: ["Mac Mini M4 Pro", "14-core CPU", "20-core GPU", "64GB unified", "1TB NVMe"],
      role: "Control plane.",
      services: [],
    },
    {
      publicName: "Blaine",
      privateName: "clanker-001",
      status: "Online",
      specs: ["Ubuntu 24.04", "16GB RAM", "309GB disk"],
      role: "Library + SIP bridge.",
      services: [],
    },
    {
      publicName: "Derry",
      privateName: "three-body",
      status: "Online",
      specs: ["Synology NAS", "Intel Atom C3538", "8GB RAM", "64TB RAID"],
      role: "Archive.",
      services: [],
    },
    {
      publicName: "Flagg",
      privateName: "dark-wizard",
      status: "Online",
      specs: ["MacBook Pro", "Apple Silicon"],
      role: "Primary dev machine.",
      services: [],
    },
    {
      publicName: "Todash",
      privateName: "nightmare-router",
      status: "Idle",
      specs: ["Linux router"],
      role: "Tailscale exit node, idle.",
      services: [],
    },
  ];

  const pods = [
    {
      name: "inngest-0",
      status: "Running",
      namespace: "joelclaw",
      description: "Event orchestration server",
      restarts: 0,
      age: "",
    },
    {
      name: "redis-0",
      status: "Running",
      namespace: "joelclaw",
      description: "State, pub/sub, loop PRD, cooldowns",
      restarts: 0,
      age: "",
    },
    {
      name: "typesense-0",
      status: "Running",
      namespace: "joelclaw",
      description: "Search engine (6 collections, auto-embedding via ONNX)",
      restarts: 0,
      age: "",
    },
    {
      name: "qdrant-0",
      status: "Running",
      namespace: "joelclaw",
      description: "Vector search (legacy, being replaced by Typesense)",
      restarts: 0,
      age: "",
    },
    {
      name: "bluesky-pds",
      status: "Running",
      namespace: "joelclaw",
      description: "AT Protocol personal data server (Helm)",
      restarts: 0,
      age: "",
    },
    {
      name: "livekit-server",
      status: "Running",
      namespace: "joelclaw",
      description: "WebRTC media server (Helm)",
      restarts: 0,
      age: "",
    },
  ];

  const daemons = [
    { name: "system-bus-worker", status: "running", description: "Inngest function worker (66 functions)" },
    { name: "gateway", status: "running", description: "Pi agent gateway daemon + Telegram bridge" },
    { name: "gateway-tripwire", status: "running", description: "Gateway watchdog (auto-restart on failure)" },
    { name: "caddy", status: "running", description: "HTTPS reverse proxy with Tailscale certs" },
    { name: "colima", status: "running", description: "Container runtime (VZ framework → Talos k8s)" },
    { name: "vault-log-sync", status: "running", description: "system-log.jsonl → Obsidian markdown notes" },
    { name: "content-sync-watcher", status: "running", description: "Vault content → web deploy trigger" },
    { name: "system-bus-sync", status: "running", description: "Monorepo → worker clone sync" },
    { name: "typesense-portforward", status: "running", description: "kubectl port-forward for Typesense :8108" },
  ];

  const cluster = [
    { key: "Orchestration", value: "Talos Linux v1.12.4 on Colima (VZ framework)" },
    { key: "Memory", value: "64 GB unified" },
    { key: "CPU", value: "Apple M4 Pro · 14 cores" },
    { key: "GPU", value: "20-core Apple GPU" },
    { key: "Storage", value: "64 TB NAS + 1 TB local NVMe" },
    { key: "Functions", value: "66 Inngest durable functions" },
    { key: "Skills", value: "65 agent skills" },
    { key: "Interconnect", value: "Tailscale WireGuard mesh" },
  ];

  const stack = [
    { layer: 6, label: "Interface", description: "joelclaw.com (Next.js + Convex), ⌘K search, vault browser" },
    { layer: 5, label: "Agents", description: "Pi gateway, coding loops, background workers, voice agent" },
    { layer: 4, label: "Orchestration", description: "Talos k8s cluster, launchd daemons, Helm releases" },
    { layer: 3, label: "Services", description: "Inngest, Redis, Typesense, PDS, LiveKit (k8s pods)" },
    { layer: 2, label: "Pipelines", description: "Video ingest, transcription, content sync, friction fix" },
    { layer: 1, label: "Memory", description: "Observations, contentResources (Convex), MEMORY.md" },
    { layer: 0, label: "Data", description: "Obsidian Vault, system-log.jsonl, 64 TB NAS archive" },
  ];

  for (const node of nodes) {
    await pushContentResource(`node:${node.publicName}`, "network_node", node);
  }

  for (const pod of pods) {
    await pushContentResource(`pod:${pod.name}`, "network_pod", pod);
  }

  for (const daemon of daemons) {
    await pushContentResource(`daemon:${daemon.name}`, "network_daemon", daemon);
  }

  for (const item of cluster) {
    await pushContentResource(`cluster:${item.key}`, "network_cluster", item);
  }

  for (const layer of stack) {
    await pushContentResource(`stack:${layer.layer}`, "network_stack", layer);
  }
}

if (import.meta.main) {
  await seedNetwork();
  console.log("Seeded network contentResources.");
}
