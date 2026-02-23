import { Suspense } from "react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { ConvexHttpClient } from "convex/browser";
import { MetricCard } from "@repo/ui/metric-card";
import { DataGrid } from "@repo/ui/data-grid";
import { StatusLed, normalizeStatusKind } from "@repo/ui/status-badge";
import { api } from "@/convex/_generated/api";
import { SITE_NAME } from "@/lib/constants";

type NetworkNode = {
  publicName: string;
  privateName?: string;
  status: string;
  specs: string[];
  role: string;
  services?: string[];
};

type NetworkPod = {
  name: string;
  status: string;
  namespace: string;
  description: string;
  restarts: number;
  age: string;
};

type NetworkDaemon = {
  name: string;
  status: string;
  description: string;
};

type NetworkCluster = {
  key: string;
  value: string;
};

type NetworkStack = {
  layer: number;
  label: string;
  description: string;
};

type ContentResourceDoc = {
  resourceId: string;
  fields: Record<string, unknown>;
};

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

// ADR-0085: Network page becomes data-driven from Convex contentResources.
export const metadata: Metadata = {
  title: `Network — ${SITE_NAME}`,
  description:
    "The joelclaw network — Talos k8s on Apple Silicon with 66 Inngest functions, Typesense search, AT Protocol PDS, Convex real-time data, and 64TB archival storage.",
};

async function listByType(type: string): Promise<ContentResourceDoc[]> {
  try {
    const docs = await convex.query(api.contentResources.listByType, { type, limit: 500 });
    return Array.isArray(docs) ? (docs as ContentResourceDoc[]) : [];
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const digest =
      typeof error === "object" && error !== null && "digest" in error
        ? String((error as { digest?: unknown }).digest ?? "")
        : "";

    // Suspense may abort unresolved prerender fetches once the static shell is emitted.
    if (digest === "HANGING_PROMISE_REJECTION" || message.includes("During prerendering, fetch() rejects")) {
      return [];
    }

    // Offline-safe fallback for build environments where Convex is unreachable.
    console.error(`[network] failed to load ${type}`, error);
    return [];
  }
}

export default function NetworkPage() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-12">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Network</h1>
        <p className="mt-2 text-sm text-neutral-400 leading-relaxed">
          Always-on personal infrastructure. <span className="text-claw">Overlook</span> runs the cluster, agents,
          and all pipelines. <span className="text-neutral-300">Blaine</span> bridges telephony.{" "}
          <span className="text-neutral-300">Derry</span> holds 64 TB of archive. Everything connected via encrypted
          WireGuard mesh.
        </p>
      </header>

      <Suspense fallback={<NetworkSectionsFallback />}>
        <NetworkSections />
      </Suspense>
    </div>
  );
}

function NetworkSectionsFallback() {
  return (
    <section className="space-y-3">
      <h2 className="text-xs uppercase tracking-widest text-neutral-500 font-medium">Loading network state</h2>
      <div className="border border-neutral-800/40 rounded-lg p-5 text-sm text-neutral-500">Resolving live topology…</div>
    </section>
  );
}

async function NetworkSections() {
  // Keep the network data panel request-time so static prerender never blocks on Convex.
  await headers();

  const [nodeDocs, podDocs, daemonDocs, clusterDocs, stackDocs] = await Promise.all([
    listByType("network_node"),
    listByType("network_pod"),
    listByType("network_daemon"),
    listByType("network_cluster"),
    listByType("network_stack"),
  ]);

  const nodeOrder = ["Overlook", "Blaine", "Derry", "Flagg", "Todash"];
  const nodes = nodeDocs
    .map((doc) => doc.fields as unknown as NetworkNode)
    .sort((a, b) => nodeOrder.indexOf(a.publicName) - nodeOrder.indexOf(b.publicName));

  const podOrder = ["inngest-0", "redis-0", "typesense-0", "bluesky-pds", "livekit-server"];
  const k8sPods = podDocs
    .map((doc) => doc.fields as unknown as NetworkPod)
    .sort((a, b) => podOrder.indexOf(a.name) - podOrder.indexOf(b.name));

  const daemonOrder = [
    "system-bus-worker",
    "gateway",
    "gateway-tripwire",
    "caddy",
    "colima",
    "vault-log-sync",
    "content-sync-watcher",
    "system-bus-sync",
    "typesense-portforward",
  ];
  const launchdServices = daemonDocs
    .map((doc) => doc.fields as unknown as NetworkDaemon)
    .sort((a, b) => daemonOrder.indexOf(a.name) - daemonOrder.indexOf(b.name));

  const clusterOrder = ["Orchestration", "Memory", "CPU", "GPU", "Storage", "Functions", "Skills", "Interconnect"];
  const clusterOverview = clusterDocs
    .map((doc) => doc.fields as unknown as NetworkCluster)
    .sort((a, b) => clusterOrder.indexOf(a.key) - clusterOrder.indexOf(b.key))
    .map((item) => ({ label: item.key, value: item.value }));

  const architectureLayers = stackDocs
    .map((doc) => doc.fields as unknown as NetworkStack)
    .sort((a, b) => b.layer - a.layer)
    .map((layer) => `Layer ${layer.layer}: ${layer.label.padEnd(13)} — ${layer.description}`);

  return (
    <>
      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-widest text-neutral-500 font-medium">Cluster</h2>
        <DataGrid columns={{ sm: 1, md: 2, lg: 2, xl: 4 }}>
          {clusterOverview.map((item) => (
            <MetricCard key={item.label} label={item.label} value={item.value} />
          ))}
        </DataGrid>
      </section>

      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-widest text-neutral-500 font-medium">Nodes</h2>
        <div className="space-y-3">
          {nodes.map((node) => {
            const nodeStatus = normalizeStatusKind(node.status);

            return (
              <article key={node.publicName} className="border border-neutral-800/40 rounded-lg p-5 space-y-3">
                <div className="flex items-start gap-3">
                  <StatusLed status={nodeStatus} size="lg" pulse={nodeStatus === "healthy"} className="mt-1" />
                  <div className="min-w-0">
                    <h3 className="text-base font-semibold text-neutral-100">{node.publicName}</h3>
                    {node.privateName && <p className="font-mono text-xs text-neutral-600">{node.privateName}</p>}
                  </div>
                </div>

                <p className="text-sm text-neutral-400 leading-relaxed">{node.role}</p>

                <p className="font-mono text-xs text-neutral-500">{node.specs.join(" · ")}</p>

                {node.services && node.services.length > 0 && (
                  <div className="pt-1">
                    <ul className="space-y-1">
                      {node.services.map((service) => (
                        <li key={service} className="text-sm text-neutral-400 flex items-start gap-2">
                          <span className="text-neutral-700 mt-1.5 text-[8px]">●</span>
                          {service}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-widest text-neutral-500 font-medium">
          K8s Pods <span className="text-neutral-700 normal-case tracking-normal">joelclaw namespace</span>
        </h2>
        <div className="border border-neutral-800/40 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-800/40 text-left">
                <th className="px-4 py-2.5 text-[11px] uppercase tracking-wider text-neutral-600 font-medium">Pod</th>
                <th className="px-4 py-2.5 text-[11px] uppercase tracking-wider text-neutral-600 font-medium">Role</th>
              </tr>
            </thead>
            <tbody>
              {k8sPods.map((pod) => {
                const podStatus = normalizeStatusKind(pod.status);

                return (
                  <tr key={pod.name} className="border-b border-neutral-800/50 last:border-0">
                    <td className="px-4 py-2.5 font-mono text-xs text-neutral-200">
                      <div className="flex items-center gap-2">
                        <StatusLed status={podStatus} pulse={podStatus === "healthy"} />
                        <span>{pod.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-neutral-400">{pod.description}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-widest text-neutral-500 font-medium">
          Daemons <span className="text-neutral-700 normal-case tracking-normal">launchd</span>
        </h2>
        <div className="border border-neutral-800/40 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-800/40 text-left">
                <th className="px-4 py-2.5 text-[11px] uppercase tracking-wider text-neutral-600 font-medium">Service</th>
                <th className="px-4 py-2.5 text-[11px] uppercase tracking-wider text-neutral-600 font-medium">Purpose</th>
              </tr>
            </thead>
            <tbody>
              {launchdServices.map((svc) => {
                const serviceStatus = normalizeStatusKind(svc.status);

                return (
                  <tr key={svc.name} className="border-b border-neutral-800/50 last:border-0">
                    <td className="px-4 py-2.5 font-mono text-xs text-neutral-200 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <StatusLed status={serviceStatus} pulse={serviceStatus === "healthy"} />
                        <span>{svc.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-neutral-400">{svc.description}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-widest text-neutral-500 font-medium">Stack</h2>
        <div className="border border-neutral-800/40 rounded-lg p-5">
          <pre className="font-mono text-xs leading-relaxed text-neutral-400 whitespace-pre-wrap">
            {architectureLayers.join("\n")}
          </pre>
        </div>
      </section>
    </>
  );
}
