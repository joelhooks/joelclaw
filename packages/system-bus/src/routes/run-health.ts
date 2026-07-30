import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Hono } from "hono";
import { readTypesenseRecoveryHealth } from "../inngest/functions/typesense-recovery-alerts";

type RecoveryHealth = Awaited<ReturnType<typeof readTypesenseRecoveryHealth>>;

export interface RunHealthDependencies {
  readRecovery: () => Promise<RecoveryHealth>;
  captureAuthConfigured: () => boolean;
  typesenseAuthConfigured: () => boolean;
  runStore: () => string;
}

const defaultDependencies: RunHealthDependencies = {
  readRecovery: () => readTypesenseRecoveryHealth(),
  captureAuthConfigured: () =>
    existsSync(
      process.env.RUN_CAPTURE_AUTH_DATABASE ??
        join(homedir(), ".joelclaw", "capture-auth.db"),
    ) || Boolean(process.env.TYPESENSE_API_KEY),
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
      const captureAuthConfigured = dependencies.captureAuthConfigured();
      const ok =
        captureAuthConfigured &&
        recovery.startupBudget === null &&
        recovery.search?.ok === true;
      return c.json({
        ok,
        service: "system-bus-run-capture",
        endpoint: "/api/runs",
        captureAuth: {
          configured: captureAuthConfigured,
          backend: captureAuthConfigured ? "sqlite" : "unavailable",
        },
        typesenseAuthConfigured: dependencies.typesenseAuthConfigured(),
        runStore: dependencies.runStore(),
        recovery,
      }, ok ? 200 : 503);
    } catch (error) {
      const captureAuthConfigured = dependencies.captureAuthConfigured();
      return c.json({
        ok: false,
        service: "system-bus-run-capture",
        endpoint: "/api/runs",
        captureAuth: {
          configured: captureAuthConfigured,
          backend: captureAuthConfigured ? "sqlite" : "unavailable",
        },
        typesenseAuthConfigured: dependencies.typesenseAuthConfigured(),
        runStore: dependencies.runStore(),
        recovery: null,
        error: `search recovery monitor failed: ${String(error).slice(0, 180)}`,
      }, 503);
    }
  });
}
