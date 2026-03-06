import type { DagNodeInput, DagRunRequest } from "./workflows/dag-orchestrator";

export const buildHealthPipeline = (): DagNodeInput[] => [
  {
    id: "k8s-pods",
    task: "check k8s pod health",
    handler: "shell",
    config: {
      command:
        'kubectl get pods -n joelclaw -o json 2>&1 | jq -r \'.items[] | "\\(.metadata.name) \\(.status.phase) \\(.status.containerStatuses[0].restartCount // 0) restarts"\' 2>/dev/null || echo "kubectl unavailable"',
    },
  },
  {
    id: "inngest-health",
    task: "check Inngest server health",
    handler: "http",
    config: { url: "http://localhost:8288/health" },
  },
  {
    id: "restate-health",
    task: "check Restate admin health",
    handler: "http",
    config: { url: "http://localhost:9070/health" },
  },
  {
    id: "redis-ping",
    task: "check Redis connectivity",
    handler: "shell",
    config: {
      command:
        'kubectl exec -n joelclaw redis-0 -- redis-cli ping 2>&1 || echo "redis unreachable"',
    },
  },
  {
    id: "synthesize",
    task: "synthesize system health report",
    handler: "infer",
    dependsOn: ["k8s-pods", "inngest-health", "restate-health", "redis-ping"],
    config: {
      prompt: [
        "You are a system health analyst for a personal AI infrastructure.",
        "Analyze these health check results and produce a brief operational status report.",
        "Be specific about what's healthy and what needs attention. No fluff.",
        "",
        "## k8s pods",
        "{{k8s-pods}}",
        "",
        "## Inngest server",
        "{{inngest-health}}",
        "",
        "## Restate admin",
        "{{restate-health}}",
        "",
        "## Redis",
        "{{redis-ping}}",
      ].join("\n"),
      system:
        "You are a terse ops analyst. Output a structured health report: overall status (healthy/degraded/down), per-component status, and any action items. Keep it under 200 words.",
    },
  },
];

export const buildHealthDagRequest = (requestId?: string): DagRunRequest => ({
  ...(requestId ? { requestId } : {}),
  pipeline: "health",
  nodes: buildHealthPipeline(),
});
