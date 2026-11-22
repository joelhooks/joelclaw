import { readFile } from "node:fs/promises";
import { pushContentResource } from "../src/lib/convex";

function isNetworkNode(value: unknown): value is { publicName: string } {
  return typeof value === "object" && value !== null && "publicName" in value &&
    typeof value.publicName === "string" && value.publicName.trim().length > 0;
}

// ADR-0085: One-time seed for data-driven network page contentResources.
async function seedNetwork(): Promise<void> {
  const path = process.env.JOELCLAW_NETWORK_NODES_FILE?.trim();
  if (!path) throw new Error("Set JOELCLAW_NETWORK_NODES_FILE to the private network seed JSON");
  const nodes: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(nodes) || !nodes.every(isNetworkNode)) {
    throw new Error("Expected an array of network nodes with a publicName");
  }

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
    { name: "content-sync-watcher", status: "running", description: "Vault content → web deploy trigger" },
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
    { layer: 1, label: "Memory", description: "Brain .svx pages, observation pages, and disposable search projections" },
    { layer: 0, label: "Data", description: "Brain repositories, Obsidian Vault sources, and the 64 TB NAS archive" },
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
