/**
 * CLI resolve — manually approve/reject a pending workflow.
 *
 * Usage:
 *   bun run resolve -- --id <workflowId> --action approve
 *   bun run resolve -- --id <workflowId> --action reject --reason "not ready"
 */

const RESTATE_INGRESS = process.env.RESTATE_INGRESS_URL ?? "http://localhost:8080";

const args = process.argv.slice(2);
const idIndex = args.indexOf("--id");
const actionIndex = args.indexOf("--action");
const reasonIndex = args.indexOf("--reason");

if (idIndex === -1 || actionIndex === -1) {
  console.log("Usage: bun run resolve -- --id <workflowId> --action approve|reject [--reason 'why']");
  process.exit(1);
}

const workflowId = args[idIndex + 1];
const action = args[actionIndex + 1];
const reason = reasonIndex !== -1 ? args[reasonIndex + 1] : `${action} via CLI`;

if (!["approve", "reject"].includes(action)) {
  console.error(`❌ Action must be "approve" or "reject", got "${action}"`);
  process.exit(1);
}

const url = `${RESTATE_INGRESS}/approvalWorkflow/${workflowId}/${action}`;
console.log(`🔗 Resolving: ${action} → ${url}`);
console.log(`   Reason: ${reason}\n`);

const response = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(reason),
});

if (!response.ok) {
  const error = await response.text();
  console.error(`❌ ${response.status}: ${error}`);
  process.exit(1);
}

const result = await response.json();
console.log(`✅ Resolved:`);
console.log(JSON.stringify(result, null, 2));
