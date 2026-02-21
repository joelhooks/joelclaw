/**
 * System health check — ping core services.
 * ADR-0062. Only notifies gateway on degradation.
 */

import { inngest } from "../client";
import { pushGatewayEvent } from "./agent-loop/utils";
import { getCurrentTasks, hasTaskMatching } from "../../tasks";
import { pushSystemStatus, pushNotification } from "../../lib/convex";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import Redis from "ioredis";
import * as typesense from "../../lib/typesense";
import { emitOtelEvent } from "../../observability/emit";

type ServiceStatus = { name: string; ok: boolean; detail?: string };

const CRITICAL_COMPONENTS = new Set([
  "redis",
  "inngest",
  "worker",
  "gateway",
  "typesense",
  "agent secrets",
]);

function getNumericEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

type OtelErrorRateSummary = {
  total: number;
  errors: number;
  rate: number;
  windowMinutes: number;
  threshold: number;
  minEvents: number;
  shouldEscalate: boolean;
  unavailable?: string;
};

async function checkRedis(): Promise<ServiceStatus> {
  const redis = new Redis({ host: "localhost", port: 6379, lazyConnect: true, connectTimeout: 3000 });
  redis.on("error", () => {});
  try {
    const pong = await redis.ping();
    return { name: "Redis", ok: pong === "PONG" };
  } catch (err) {
    return { name: "Redis", ok: false, detail: String(err) };
  } finally {
    redis.disconnect();
  }
}

async function checkQdrant(): Promise<ServiceStatus> {
  try {
    const res = await fetch("http://localhost:6333/healthz", { signal: AbortSignal.timeout(3000) });
    return { name: "Qdrant", ok: res.ok };
  } catch (err) {
    return { name: "Qdrant", ok: false, detail: String(err) };
  }
}

async function checkInngest(): Promise<ServiceStatus> {
  try {
    const res = await fetch("http://localhost:8288/health", { signal: AbortSignal.timeout(3000) });
    return { name: "Inngest", ok: res.ok };
  } catch (err) {
    return { name: "Inngest", ok: false, detail: String(err) };
  }
}

async function checkWorker(): Promise<ServiceStatus> {
  try {
    const res = await fetch("http://localhost:3111/", { signal: AbortSignal.timeout(3000) });
    return { name: "Worker", ok: res.ok };
  } catch (err) {
    return { name: "Worker", ok: false, detail: String(err) };
  }
}

async function checkGateway(): Promise<ServiceStatus> {
  try {
    // Check PID file — is the process alive?
    const pidRaw = await readFile("/tmp/joelclaw/gateway.pid", "utf8").catch(() => "");
    const pid = parseInt(pidRaw.trim(), 10);
    if (!pid || isNaN(pid)) {
      return { name: "Gateway", ok: false, detail: "no PID file" };
    }

    // Check process is alive (kill -0 doesn't actually kill)
    try {
      process.kill(pid, 0);
    } catch {
      return { name: "Gateway", ok: false, detail: `PID ${pid} is dead` };
    }

    // Check WS server responds — read port, open WS, request status, close
    const portRaw = await readFile("/tmp/joelclaw/gateway.ws.port", "utf8").catch(() => "");
    const wsPort = parseInt(portRaw.trim(), 10);
    if (!wsPort || isNaN(wsPort)) {
      return { name: "Gateway", ok: false, detail: "no WS port file — daemon may not have WS server" };
    }

    // Probe via HTTP upgrade attempt (Bun.serve returns 426 for non-WS)
    const res = await fetch(`http://localhost:${wsPort}/`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
    if (!res) {
      return { name: "Gateway", ok: false, detail: `WS port ${wsPort} not responding` };
    }
    // 426 = "Upgrade Required" = WS server is there and healthy
    if (res.status === 426) {
      return { name: "Gateway", ok: true };
    }
    return { name: "Gateway", ok: false, detail: `unexpected status ${res.status}` };
  } catch (err) {
    return { name: "Gateway", ok: false, detail: String(err) };
  }
}

async function checkTypesense(): Promise<ServiceStatus> {
  try {
    const res = await fetch("http://localhost:8108/health", {
      signal: AbortSignal.timeout(3000),
      headers: { "X-TYPESENSE-API-KEY": process.env.TYPESENSE_API_KEY ?? "" },
    });
    const data = await res.json() as { ok?: boolean };
    return { name: "Typesense", ok: data.ok === true };
  } catch (err) {
    return { name: "Typesense", ok: false, detail: String(err) };
  }
}

async function checkAgentSecrets(): Promise<ServiceStatus> {
  try {
    const result = spawnSync("secrets", ["health"], {
      encoding: "utf8",
      timeout: 4000,
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (result.status === 0) {
      return { name: "Agent Secrets", ok: true };
    }

    const text = `${result.stderr ?? ""}\n${result.stdout ?? ""}`
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith("{"));
    return {
      name: "Agent Secrets",
      ok: false,
      detail: (text ?? "secrets daemon unreachable").slice(0, 140),
    };
  } catch (err) {
    return { name: "Agent Secrets", ok: false, detail: String(err).slice(0, 140) };
  }
}

async function checkWebhooks(): Promise<ServiceStatus> {
  try {
    // Probe webhook server locally (avoids TLS cert issues with Tailscale funnel)
    const res = await fetch("http://localhost:3111/webhooks", {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = await res.json() as { status?: string; providers?: string[] };
      return { name: "Webhooks", ok: true, detail: `providers: ${data.providers?.join(", ") ?? "none"}` };
    }
    return { name: "Webhooks", ok: false, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { name: "Webhooks", ok: false, detail: String(err) };
  }
}

async function checkOtelErrorRate(): Promise<OtelErrorRateSummary> {
  const windowMinutes = getNumericEnv("OTEL_EVENTS_ERROR_RATE_WINDOW_MINUTES", 15);
  const threshold = getNumericEnv("OTEL_EVENTS_ERROR_RATE_THRESHOLD", 0.2);
  const minEvents = getNumericEnv("OTEL_EVENTS_ERROR_RATE_MIN_EVENTS", 20);
  const cutoff = Date.now() - windowMinutes * 60 * 1000;

  const baseFilter = `timestamp:>=${Math.floor(cutoff)} && component:!=check-system-health`;

  try {
    const [all, errors] = await Promise.all([
      typesense.search({
        collection: "otel_events",
        q: "*",
        query_by: "action,component,source,error,metadata_json,search_text",
        per_page: 1,
        filter_by: baseFilter,
      }),
      typesense.search({
        collection: "otel_events",
        q: "*",
        query_by: "action,component,source,error,metadata_json,search_text",
        per_page: 1,
        filter_by: `${baseFilter} && level:=[error,fatal]`,
      }),
    ]);

    const total = all.found ?? 0;
    const errorCount = errors.found ?? 0;
    const rate = total > 0 ? errorCount / total : 0;

    return {
      total,
      errors: errorCount,
      rate,
      windowMinutes,
      threshold,
      minEvents,
      shouldEscalate: total >= minEvents && rate >= threshold,
    };
  } catch (error) {
    return {
      total: 0,
      errors: 0,
      rate: 0,
      windowMinutes,
      threshold,
      minEvents,
      shouldEscalate: false,
      unavailable: String(error),
    };
  }
}

export const checkSystemHealth = inngest.createFunction(
  { id: "check/system-health", concurrency: { limit: 1 }, retries: 1 },
  [{ event: "system/health.requested" }, { event: "system/health.check" }],
  async ({ step }) => {
    const services = await step.run("ping-services", async () => {
      const results = await Promise.all([
        checkRedis(),
        checkQdrant(),
        checkInngest(),
        checkWorker(),
        checkGateway(),
        checkWebhooks(),
        checkTypesense(),
        checkAgentSecrets(),
      ]);
      return results;
    });

    await step.run("slog-agent-secrets-health", async () => {
      const service = services.find((item) => item.name === "Agent Secrets");
      if (!service) return { skipped: true, reason: "service-missing" };

      const redis = new Redis({
        host: "localhost",
        port: 6379,
        lazyConnect: true,
        connectTimeout: 3000,
      });
      redis.on("error", () => {});

      try {
        if (!service.ok) {
          const shouldLog = await redis.set(
            "health:agent-secrets:down:logged",
            String(Date.now()),
            "EX",
            3600,
            "NX"
          );
          if (!shouldLog) return { logged: false, reason: "cooldown" };

          await step.sendEvent("slog-agent-secrets-down", {
            name: "system/log.written",
            data: {
              action: "degraded",
              tool: "agent-secrets",
              detail: `Agent Secrets daemon unavailable: ${service.detail ?? "unknown"}`,
              reason: "check/system-health",
            },
          });

          return { logged: true, state: "down" };
        }

        const shouldLogRecovery = await redis.set(
          "health:agent-secrets:up:logged",
          String(Date.now()),
          "EX",
          3600,
          "NX"
        );
        await redis.del("health:agent-secrets:down:logged");
        if (!shouldLogRecovery) return { logged: false, state: "up", reason: "cooldown" };

        await step.sendEvent("slog-agent-secrets-up", {
          name: "system/log.written",
          data: {
            action: "recovered",
            tool: "agent-secrets",
            detail: "Agent Secrets daemon healthy",
            reason: "check/system-health",
          },
        });
        return { logged: true, state: "up" };
      } catch (error) {
        return { logged: false, error: String(error) };
      } finally {
        redis.disconnect();
      }
    });

    const otelErrorRate = await step.run("check-otel-error-rate", async () =>
      checkOtelErrorRate()
    );

    await step.run("emit-otel-health-summary", async () => {
      const degradedCount = services.filter((service) => !service.ok).length;
      await emitOtelEvent({
        level: degradedCount === 0 ? "info" : "warn",
        source: "worker",
        component: "check-system-health",
        action: "system.health.checked",
        success: degradedCount === 0,
        metadata: {
          degradedCount,
          services: services.map((service) => ({
            name: service.name,
            ok: service.ok,
          })),
          otelErrorRate,
        },
      });
    });

    // Push all service statuses to Convex dashboard — ADR-0075
    await step.run("push-to-convex", async () => {
      await Promise.allSettled(
        services.map((s) =>
          pushSystemStatus(
            s.name.toLowerCase(),
            s.ok ? "healthy" : "down",
            s.detail
          )
        )
      );
    });

    const degraded = services.filter((s) => !s.ok);

    if (otelErrorRate.shouldEscalate) {
      await step.run("notify-otel-error-rate", async () => {
        const prompt = [
          "## 🚨 Elevated Error Rate",
          "",
          `Window: last ${otelErrorRate.windowMinutes} minutes`,
          `Errors: ${otelErrorRate.errors} / ${otelErrorRate.total} (${Math.round(otelErrorRate.rate * 100)}%)`,
          `Threshold: ${Math.round(otelErrorRate.threshold * 100)}% with >= ${otelErrorRate.minEvents} events`,
          "",
          "Investigate recent otel_events grouped by component and prioritize fatal/error sources.",
        ].join("\n");

        await pushGatewayEvent({
          type: "system.health.error-rate",
          source: "inngest/check-system-health",
          payload: {
            prompt,
            level: "error",
            immediateTelegram: true,
            otelErrorRate,
          },
        });
      });

      await step.run("notify-convex-otel-error-rate", async () => {
        await pushNotification(
          "error",
          `Elevated error rate: ${Math.round(otelErrorRate.rate * 100)}%`,
          `Errors ${otelErrorRate.errors}/${otelErrorRate.total} in ${otelErrorRate.windowMinutes}m`
        );
      });
    }

    // NOOP: all healthy → no notification
    if (degraded.length === 0) {
      // ADR-0085: trigger live network status collection after health checks.
      await step.sendEvent("emit-network-update", {
        name: "system/network.update",
        data: { source: "check-system-health", checkedAt: Date.now() },
      });
      return { status: "noop", services };
    }

    // Filter: don't re-alert about things that already have tasks
    const newDegraded = await step.run("filter-against-tasks", async () => {
      const tasks = await getCurrentTasks();
      return degraded.filter((s) => !hasTaskMatching(tasks, s.name));
    });

    if (newDegraded.length === 0) {
      // ADR-0085: trigger live network status collection after health checks.
      await step.sendEvent("emit-network-update", {
        name: "system/network.update",
        data: { source: "check-system-health", checkedAt: Date.now() },
      });
      return { status: "noop", reason: "degraded but already tracked in tasks", services };
    }

    // Something's down and NOT already tracked → alert gateway
    const typedDegraded = newDegraded as unknown as ServiceStatus[];
    const degradedNames = typedDegraded.map((s) => s.name);
    const degradedDetails = typedDegraded.map((s) => `${s.name}: ${s.detail ?? "down"}`);
    const criticalDown = typedDegraded.filter((service) =>
      CRITICAL_COMPONENTS.has(service.name.toLowerCase())
    );

    await step.run("notify-degradation", async () => {
      const lines = [
        "## 🚨 System Health Degradation",
        "",
        ...services.map((s) => {
          const icon = s.ok ? "✅" : "❌";
          const detail = s.detail ? ` — ${s.detail.slice(0, 100)}` : "";
          return `- ${icon} **${s.name}**${detail}`;
        }),
      ];

      await pushGatewayEvent({
        type: "system.health.degraded",
        source: "inngest/check-system-health",
        payload: {
          prompt: lines.join("\n"),
          degraded: degraded.map((s) => s.name),
        },
      });
    });

    if (criticalDown.length > 0) {
      await step.run("notify-fatal-immediate", async () => {
        const prompt = [
          "## ☠️ Critical Service Failure",
          "",
          ...criticalDown.map((service) => `- ${service.name}: ${service.detail ?? "down"}`),
          "",
          "Immediate attention required. This alert bypassed normal digest batching.",
        ].join("\n");

        await pushGatewayEvent({
          type: "system.fatal",
          source: "inngest/check-system-health",
          payload: {
            prompt,
            level: "fatal",
            immediateTelegram: true,
            critical: criticalDown.map((service) => service.name),
          },
        });
      });

      await step.run("emit-fatal-service-alert", async () => {
        await emitOtelEvent({
          level: "fatal",
          source: "worker",
          component: "check-system-health",
          action: "system.health.critical_failure",
          success: false,
          error: criticalDown.map((service) => service.name).join(", "),
          metadata: {
            criticalDown,
          },
        });
      });
    }

    // Push degradation notification to Convex dashboard — ADR-0075
    await step.run("notify-convex-degradation", async () => {
      await pushNotification(
        "error",
        `Health degradation: ${degradedNames.join(", ")}`,
        degradedDetails.join("\n")
      );
    });

    // ADR-0085: trigger live network status collection after health checks.
    await step.sendEvent("emit-network-update", {
      name: "system/network.update",
      data: { source: "check-system-health", checkedAt: Date.now() },
    });

    return {
      status: "degraded",
      degraded: degraded.map((s) => s.name),
      services,
      otelErrorRate,
    };
  }
);
