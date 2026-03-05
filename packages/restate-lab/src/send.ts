/**
 * Send a request to the Restate lab service.
 *
 * Usage:
 *   bun run send                    # durableSteps with random runId
 *   bun run send -- --level 1       # explicit level (future-proof)
 *
 * Prerequisites:
 *   1. Port-forward Restate ingress: kubectl port-forward -n joelclaw svc/restate 8080:8080
 *   2. Worker running: bun run lab
 *   3. Worker registered with Restate (see register.sh)
 */

const RESTATE_INGRESS = process.env.RESTATE_INGRESS_URL ?? "http://localhost:8080";

const runId = `run-${Date.now().toString(36)}`;

console.log(`📤 Sending durableSteps request — runId: ${runId}`);
console.log(`   Restate ingress: ${RESTATE_INGRESS}\n`);

const response = await fetch(`${RESTATE_INGRESS}/labService/durableSteps`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ runId }),
});

if (!response.ok) {
  console.error(`❌ ${response.status}: ${await response.text()}`);
  process.exit(1);
}

const result = await response.json();
console.log(`\n✅ Response:`);
console.log(JSON.stringify(result, null, 2));
