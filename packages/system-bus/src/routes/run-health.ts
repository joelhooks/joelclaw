import { type Hono } from "hono";
import { readTypesenseRecoveryHealth } from "../inngest/functions/typesense-recovery-alerts";

type RecoveryHealth = Awaited<ReturnType<typeof readTypesenseRecoveryHealth>>;

export interface RunHealthDependencies {
  readRecovery: () => Promise<RecoveryHealth>;
  typesenseAuthConfigured: () => boolean;
  runStore: () => string;
}

const defaultDependencies: RunHealthDependencies = {
  readRecovery: () => readTypesenseRecoveryHealth(),
  typesenseAuthConfigured: () => Boolean(process.env.TYPESENSE_API_KEY),
  runStore: () => process.env.MEMORY_RUN_STORE ?? "~/.joelclaw/runs-dev",
};

export function registerRunHealthRoute(
  app: Hono,
  dependencies: RunHealthDependencies = defaultDependencies,
): void {
  app.get("/api/runs/health", async (c) => {
    try {
      const recovery = await dependencies.readRecovery();
      const ok = recovery.startupBudget === null && recovery.search?.ok === true;
      return c.json({
        ok,
        service: "system-bus-run-capture",
        endpoint: "/api/runs",
        typesenseAuthConfigured: dependencies.typesenseAuthConfigured(),
        runStore: dependencies.runStore(),
        recovery,
      }, ok ? 200 : 503);
    } catch (error) {
      return c.json({
        ok: false,
        service: "system-bus-run-capture",
        endpoint: "/api/runs",
        typesenseAuthConfigured: dependencies.typesenseAuthConfigured(),
        runStore: dependencies.runStore(),
        recovery: null,
        error: `search recovery monitor failed: ${String(error).slice(0, 180)}`,
      }, 503);
    }
  });
}
