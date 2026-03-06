/**
 * Trigger a DAG workload through Restate.
 *
 * Usage:
 *   bun run dag                           # demo pipeline (noop nodes)
 *   bun run dag -- --pipeline health      # real system health check
 *   bun run dag -- --pipeline research --topic "Restate vs Temporal"
 *   bun run dag -- --id my-run-1
 *   bun run dag -- --sleep-ms 750         # noop node delay (demo only)
 */

import type { DagNodeInput } from "./workflows/dag-orchestrator";

const RESTATE_INGRESS =
  process.env.RESTATE_INGRESS_URL ?? "http://localhost:8080";

const args = process.argv.slice(2);
const getArg = (flag: string) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
};

const pipeline = getArg("--pipeline") ?? "demo";
const workflowId = getArg("--id") ?? `dag-${Date.now().toString(36)}`;
const sleepMs = Number.parseInt(getArg("--sleep-ms") ?? "500", 10);
const topic = getArg("--topic") ?? "Restate durable execution";

const nodeDelay = Number.isFinite(sleepMs)
  ? Math.max(0, Math.min(sleepMs, 5_000))
  : 500;

// --- Pipeline definitions ---

function demoPipeline(): DagNodeInput[] {
  return [
    { id: "discover", task: "discover source inputs", simulatedMs: nodeDelay },
    { id: "analyze", task: "analyze source inputs", simulatedMs: nodeDelay },
    {
      id: "synthesize",
      task: "synthesize outputs",
      dependsOn: ["discover", "analyze"],
      simulatedMs: nodeDelay,
    },
    {
      id: "publish",
      task: "publish final artifact",
      dependsOn: ["synthesize"],
      simulatedMs: nodeDelay,
    },
  ];
}

function healthPipeline(): DagNodeInput[] {
  return [
    {
      id: "k8s-pods",
      task: "check k8s pod health",
      handler: "shell",
      config: {
        command:
          "kubectl get pods -n joelclaw -o json 2>&1 | jq -r '.items[] | \"\\(.metadata.name) \\(.status.phase) \\(.status.containerStatuses[0].restartCount // 0) restarts\"' 2>/dev/null || echo 'kubectl unavailable'",
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
          "kubectl exec -n joelclaw redis-0 -- redis-cli ping 2>&1 || echo 'redis unreachable'",
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
}

function researchPipeline(researchTopic: string): DagNodeInput[] {
  return [
    {
      id: "web-search",
      task: `search the web for: ${researchTopic}`,
      handler: "shell",
      config: {
        command: `curl -sS "https://api.duckduckgo.com/?q=${encodeURIComponent(researchTopic)}&format=json&no_html=1" | jq -r '.AbstractText // .RelatedTopics[:5][] .Text // "no results"' 2>/dev/null | head -50`,
      },
    },
    {
      id: "vault-search",
      task: `search local vault for: ${researchTopic}`,
      handler: "shell",
      config: {
        command: `grep -ril "${researchTopic.replace(/"/g, '\\"').slice(0, 60)}" ~/Vault/docs/decisions/ 2>/dev/null | head -10 | while read f; do echo "--- $f ---"; head -30 "$f"; echo; done || echo 'no vault matches'`,
      },
    },
    {
      id: "memory-recall",
      task: `search agent memory for: ${researchTopic}`,
      handler: "shell",
      config: {
        command: `joelclaw recall "${researchTopic.replace(/"/g, '\\"').slice(0, 80)}" 2>/dev/null | head -40 || echo 'recall unavailable'`,
      },
    },
    {
      id: "synthesize",
      task: "synthesize research findings",
      handler: "infer",
      dependsOn: ["web-search", "vault-search", "memory-recall"],
      config: {
        prompt: [
          `Research topic: ${researchTopic}`,
          "",
          "Synthesize these sources into a brief research memo.",
          "Cite which source each finding came from.",
          "",
          "## Web search results",
          "{{web-search}}",
          "",
          "## Vault/ADR matches",
          "{{vault-search}}",
          "",
          "## Agent memory",
          "{{memory-recall}}",
        ].join("\n"),
        system:
          "You are a research analyst. Produce a structured memo: key findings, source attribution, gaps, and recommended next steps. Under 300 words.",
      },
    },
  ];
}

// --- Select pipeline ---

let nodes: DagNodeInput[];

switch (pipeline) {
  case "health":
    nodes = healthPipeline();
    break;
  case "research":
    nodes = researchPipeline(topic);
    break;
  case "demo":
  default:
    nodes = demoPipeline();
    break;
}

// --- Send to Restate ---

const request = { requestId: workflowId, nodes };

console.log(`🕸️  Triggering DAG workload — ${workflowId}`);
console.log(`   Pipeline: ${pipeline}`);
console.log(`   Restate: ${RESTATE_INGRESS}`);
console.log(`   Nodes: ${nodes.map((n) => `${n.id}(${n.handler ?? "noop"})`).join(", ")}\n`);

const response = await fetch(
  `${RESTATE_INGRESS}/dagOrchestrator/${workflowId}/run`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  },
);

if (!response.ok) {
  const error = await response.text();
  console.error(`❌ ${response.status}: ${error}`);
  process.exit(1);
}

const result = await response.json();

console.log(`✅ DAG run complete:`);
console.log(`   workflowId: ${result.workflowId}`);
console.log(`   nodeCount: ${result.nodeCount}`);
console.log(`   waveCount: ${result.waveCount}`);
console.log(
  `   completionOrder: ${(result.completionOrder ?? []).join(" → ")}`,
);
console.log(``);

// For real pipelines, print the synthesizer output nicely
const lastWave = result.waves?.[result.waves.length - 1];
const synthResult = lastWave?.results?.find(
  (r: { nodeId: string }) => r.nodeId === "synthesize",
);
if (synthResult?.handler === "infer" && synthResult.output) {
  console.log("━".repeat(60));
  console.log(synthResult.output);
  console.log("━".repeat(60));
}

console.log(`\nFull result:\n${JSON.stringify(result, null, 2)}`);
