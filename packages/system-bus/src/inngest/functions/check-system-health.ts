/**
 * System health check — ping core services.
 * ADR-0062. Only notifies gateway on degradation.
 */

import { inngest } from "../client";
import { pushGatewayEvent } from "./agent-loop/utils";
import { getCurrentTasks, hasTaskMatching } from "../../tasks";
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
