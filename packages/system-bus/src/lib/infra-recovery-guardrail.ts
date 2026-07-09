/**
 * Central safety policy for LLM-backed infra failure/retry/self-healing routers.
 *
 * 2026-07 incident: a backup snapshot failure fanned out through two routers
 * (backup-failure-router + self-healing-router) that both called infer() and
 * could both schedule retries, producing ~7,400 model calls in 36h. Fix:
 * infra recovery routing is deterministic by default; model routing requires
 * an explicit per-domain opt-in env var. See also inference-circuit.ts
 * (ADR-0191) for the complementary failure-rate circuit breaker, which now
 * also trips on timeout/usage_limit_reached, not just no-op output.
 *
 * Rules encoded here:
 * - deterministic default: infra recovery decisions never call infer() unless opted in
 * - one event family owns retry for a given domain; other routers block/observe/escalate
 * - retry budgets are bounded and alert on exhaustion (see callers)
 */

export type InfraRecoveryDomain =
  | "backup"
  | "self-healing";

const DOMAIN_ENV_VARS: Record<InfraRecoveryDomain, string> = {
  backup: "JOELCLAW_BACKUP_FAILURE_MODEL_ROUTER",
  "self-healing": "JOELCLAW_SELF_HEALING_MODEL_ROUTER",
};

export function infraRecoveryModelRouterEnvVar(domain: InfraRecoveryDomain): string {
  return DOMAIN_ENV_VARS[domain];
}

export function isInfraRecoveryModelRouterEnabled(domain: InfraRecoveryDomain): boolean {
  return process.env[DOMAIN_ENV_VARS[domain]] === "1";
}
