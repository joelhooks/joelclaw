/**
 * Trigger a system-bus-worker deploy through the Restate deploy gate.
 *
 * Usage:
 *   bun run deploy                                    # default tag
 *   bun run deploy -- --tag 20260305-1200             # custom tag
 *   bun run deploy -- --reason "new functions"        # deploy reason
 *   bun run deploy -- --skip-approval                 # skip gate (automated)
 *   bun run deploy -- --lab                           # short reminder intervals
 *
 * This replaces calling k8s/publish-system-bus-worker.sh directly.
 * The workflow handles auth, build, push, approval, apply, verify.
 */

const RESTATE_INGRESS = process.env.RESTATE_INGRESS_URL ?? "http://localhost:8080";

const args = process.argv.slice(2);
const getArg = (flag: string) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
};

const tag = getArg("--tag");
const reason = getArg("--reason") ?? "manual deploy via trigger script";
const skipApproval = args.includes("--skip-approval");
const labMode = args.includes("--lab");

const deployId = `deploy-${Date.now().toString(36)}`;

const request = {
  tag,
  reason,
  skipApproval,
  ...(labMode ? { reminderIntervals: [15_000, 30_000, 45_000, 60_000] } : {}),
};

console.log(`🚀 Triggering deploy gate — ${deployId}`);
console.log(`   Tag: ${tag ?? "(auto)"}`);
console.log(`   Reason: ${reason}`);
console.log(`   Approval: ${skipApproval ? "skipped" : "required"}`);
console.log(`   Restate: ${RESTATE_INGRESS}\n`);

const response = await fetch(
  `${RESTATE_INGRESS}/deployGate/${deployId}/run`,
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
console.log(`\n${result.decision === "rejected" ? "❌" : "✅"} Deploy complete:`);
console.log(JSON.stringify(result, null, 2));
