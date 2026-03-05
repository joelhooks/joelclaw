/**
 * Restate promise resolver.
 *
 * Translates channel callbacks into Restate workflow handler calls.
 * Channel-agnostic — any channel's callback listener calls this.
 *
 * The resolver knows how to map action values to Restate handler names.
 * This is the bridge between "human tapped a button" and
 * "Restate workflow promise resolved."
 */

import type { CallbackData } from "./channels/types";

const RESTATE_INGRESS_URL = process.env.RESTATE_INGRESS_URL ?? "http://localhost:8080";

/**
 * Resolve a Restate workflow promise via the workflow's named handlers.
 *
 * Maps callback action to handler:
 *   "approve" → POST /approvalWorkflow/{id}/approve
 *   "reject"  → POST /approvalWorkflow/{id}/reject
 *   custom    → POST /{service}/{id}/{action}
 */
export async function resolveCallback(data: CallbackData): Promise<void> {
  const url = `${RESTATE_INGRESS_URL}/${data.serviceName}/${data.workflowId}/${data.action}`;

  console.log(`🔗 Resolving: ${data.action} → ${url}`);

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(`${data.action} via ${data.serviceName}`),
  });

  if (response.status === 409) {
    // Promise already resolved — another button press or CLI resolve beat us.
    // This is expected when multiple messages have buttons for the same workflow.
    console.log(`⚡ Already resolved: ${data.action} on ${data.workflowId} (409 — duplicate callback, safe to ignore)`);
    return;
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Restate resolve failed: ${response.status} ${errorText}`);
  }

  const result = await response.json();
  console.log(`✅ Resolved: ${data.action} on ${data.workflowId}`, result);
}
