/**
 * System health check — ping core services.
 * ADR-0062. Only notifies gateway on degradation.
 */

import { inngest } from "../client";
import { pushGatewayEvent } from "./agent-loop/utils";
import { getCurrentTasks, hasTaskMatching } from "../../tasks";
import { readFile } from "node:fs/promises";
import Redis from "ioredis";

type ServiceStatus = { name: string; ok: boolean; detail?: string };

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

async function checkWebhookFunnel(): Promise<ServiceStatus> {
  try {
    const res = await fetch("https://panda.tail7af24.ts.net:8443/webhooks", {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json() as { status?: string; providers?: string[] };
      return { name: "Webhook Funnel", ok: true, detail: `providers: ${data.providers?.join(", ") ?? "none"}` };
    }
    return { name: "Webhook Funnel", ok: false, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { name: "Webhook Funnel", ok: false, detail: String(err) };
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
        checkWebhookFunnel(),
      ]);
      return results;
    });

    const degraded = services.filter((s) => !s.ok);

    // NOOP: all healthy → no notification
    if (degraded.length === 0) {
      return { status: "noop", services };
    }

    // Filter: don't re-alert about things that already have tasks
    const newDegraded = await step.run("filter-against-tasks", async () => {
      const tasks = await getCurrentTasks();
      return degraded.filter((s) => !hasTaskMatching(tasks, s.name));
    });

    if (newDegraded.length === 0) {
      return { status: "noop", reason: "degraded but already tracked in tasks", services };
    }

    // Something's down and NOT already tracked → alert gateway
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

    return { status: "degraded", degraded: degraded.map((s) => s.name), services };
  }
);
