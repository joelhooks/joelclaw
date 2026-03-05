/**
 * Send an approval request to the Restate lab.
 *
 * Usage:
 *   bun run send-approval                              # default request
 *   bun run send-approval -- --title "Deploy v2.0"     # custom title
 *
 * This triggers the approvalWorkflow. The workflow sends a notification
 * to the primary channel (Telegram/Console) and blocks until a human
 * responds via button press or CLI resolve.
 *
 * The workflow ID is deterministic from the request, so you can
 * track and resolve it by ID.
 */

const RESTATE_INGRESS = process.env.RESTATE_INGRESS_URL ?? "http://localhost:8080";

const title = process.argv.includes("--title")
  ? process.argv[process.argv.indexOf("--title") + 1]
  : "Deploy system-bus-worker v3.2";

const workflowId = `approval-${Date.now().toString(36)}`;

// Lab mode: short intervals for testing (15s, 30s, 45s, 60s)
// Production would use: 4h, 12h, 24h, 48h
const labMode = !process.argv.includes("--prod");

const request = {
  title,
  description: "This will roll out the latest Inngest functions to the k8s cluster. Includes 3 new functions and 2 breaking changes to event schemas.",
  requestedBy: "restate-lab",
  metadata: {
    environment: labMode ? "lab" : "production",
    changes: "3 new functions, 2 schema changes",
  },
  ...(labMode ? { reminderIntervals: [15_000, 30_000, 45_000, 60_000] } : {}),
};

console.log(`📤 Sending approval request — workflowId: ${workflowId}`);
console.log(`   Title: ${request.title}`);
console.log(`   Restate ingress: ${RESTATE_INGRESS}\n`);

const response = await fetch(
  `${RESTATE_INGRESS}/approvalWorkflow/${workflowId}/run`,
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
console.log(`\n✅ Workflow completed:`);
console.log(JSON.stringify(result, null, 2));
