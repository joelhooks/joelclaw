/**
 * Trigger a DAG fan-out/fan-in workload through Restate.
 *
 * Usage:
 *   bun run dag
 *   bun run dag -- --id dag-demo-1
 *   bun run dag -- --sleep-ms 750
 */

const RESTATE_INGRESS = process.env.RESTATE_INGRESS_URL ?? "http://localhost:8080";

const args = process.argv.slice(2);
const getArg = (flag: string) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
};

const workflowId = getArg("--id") ?? `dag-${Date.now().toString(36)}`;
const sleepMs = Number.parseInt(getArg("--sleep-ms") ?? "500", 10);

const nodeDelay = Number.isFinite(sleepMs) ? Math.max(0, Math.min(sleepMs, 5_000)) : 500;

const request = {
  requestId: workflowId,
  nodes: [
    {
      id: "discover",
      task: "discover source inputs",
      simulatedMs: nodeDelay,
    },
    {
      id: "analyze",
      task: "analyze source inputs",
      simulatedMs: nodeDelay,
    },
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
  ],
};

console.log(`🕸️  Triggering DAG workload — ${workflowId}`);
console.log(`   Restate: ${RESTATE_INGRESS}`);
console.log(`   Node delay: ${nodeDelay}ms\n`);

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
console.log(`   completionOrder: ${(result.completionOrder ?? []).join(" -> ")}`);
console.log(``);
console.log(JSON.stringify(result, null, 2));
