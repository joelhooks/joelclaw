import { getRedisPort } from "../../lib/redis";
/**
 * NAS soak monitoring for ADR-0088 revisit gate.
 *
 * Samples mount health + basic throughput on /Volumes NAS mounts and persists
 * rolling data in Redis. Daily review compares results against ADR-0088 gates,
 * notifies gateway, and escalates to TaskPort when action is needed.
 */

import Redis from "ioredis";
import { inngest } from "../client";
import { TodoistTaskAdapter } from "../../tasks/adapters/todoist";

const SAMPLES_KEY = "nas:soak:samples:v1";
const SAMPLE_RETENTION_SECONDS = 14 * 24 * 60 * 60;
const SAMPLE_KEEP_COUNT = 10_000;
const REVIEW_TASK_LABEL = "nas-soak";
const REVIEW_TASK_PROJECT = "Agent Work";

const NAS_NVME_MOUNT = "/Volumes/nas-nvme";
const NAS_NVME_SRC = "three-body:/volume2/data";
const THREE_BODY_MOUNT = "/Volumes/three-body";
const THREE_BODY_SRC = "192.168.1.163:/volume1/joelclaw";

// ADR-0088 revisit thresholds.
const GATE_MIN_SAMPLE_HOURS = 48;
const GATE_MIN_WRITE_MBPS = 700;
const BENCH_SIZE_MIB = 64;

type MountSample = {
  mount: string;
  source: string;
  mounted: boolean;
  accessOk: boolean;
  writeOk: boolean;
  writeMbps?: number;
  readMbps?: number;
  errors: string[];
};

type SoakSample = {
  ts: number;
  isoTime: string;
  md2ResyncActive: boolean;
  md2ProgressPct?: number;
  mounts: MountSample[];
};

function normalizeMountSample(value: unknown): MountSample | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.mount !== "string" || typeof raw.source !== "string") return null;
  if (!Array.isArray(raw.errors)) return null;
  return {
    mount: raw.mount,
    source: raw.source,
    mounted: Boolean(raw.mounted),
    accessOk: Boolean(raw.accessOk),
    writeOk: Boolean(raw.writeOk),
    writeMbps: typeof raw.writeMbps === "number" ? raw.writeMbps : undefined,
    readMbps: typeof raw.readMbps === "number" ? raw.readMbps : undefined,
    errors: raw.errors.filter((e): e is string => typeof e === "string"),
  };
}

type CmdResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

type Md2Status = {
  resyncActive: boolean;
  progressPct?: number;
};

let redisClient: Redis | null = null;

function getRedis(): Redis {
  if (redisClient) return redisClient;
  const isTest = process.env.NODE_ENV === "test" || process.env.BUN_TEST === "1";
  redisClient = new Redis({
    host: process.env.REDIS_HOST ?? "localhost",
    port: getRedisPort(),
    lazyConnect: true,
    retryStrategy: isTest ? () => null : undefined,
  });
  redisClient.on("error", () => {});
  return redisClient;
}

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  return new Response(stream).text();
}

async function runCmd(args: string[], timeoutMs = 8_000): Promise<CmdResult> {
  const proc = Bun.spawn(args, {
    env: { ...process.env, TERM: "dumb" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  const [stdout, stderr, exitCode] = await Promise.all([
    readStream(proc.stdout),
    readStream(proc.stderr),
    proc.exited.catch(() => 124),
  ]);
  clearTimeout(timeout);

  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim(), timedOut };
}

async function isMounted(dest: string): Promise<boolean> {
  const mountOut = await runCmd(["/sbin/mount"], 5_000);
  if (mountOut.exitCode !== 0) return false;
  return mountOut.stdout.includes(` on ${dest} `);
}

async function quickAccess(dest: string): Promise<{ ok: boolean; err?: string }> {
  const result = await runCmd(["ls", "-la", dest], 6_000);
  if (result.exitCode === 0) return { ok: true };
  return {
    ok: false,
    err: result.stderr || result.stdout || `ls failed (${result.exitCode})`,
  };
}

async function quickWrite(dest: string): Promise<{ ok: boolean; err?: string }> {
  const marker = `${dest}/.nas-soak-write-${Date.now()}`;
  const write = await runCmd(["sh", "-lc", `echo ok > '${marker}'`], 6_000);
  if (write.exitCode !== 0) {
    return { ok: false, err: write.stderr || write.stdout || `write failed (${write.exitCode})` };
  }
  await runCmd(["rm", "-f", marker], 4_000);
  return { ok: true };
}

async function benchReadWrite(dest: string): Promise<{
  writeMbps?: number;
  readMbps?: number;
  err?: string;
}> {
  const benchPath = `${dest}/.nas-soak-bench-${Date.now()}.bin`;
  const bs = "4m";
  const count = String(BENCH_SIZE_MIB / 4);

  const writeStart = Date.now();
  const write = await runCmd(
    ["dd", "if=/dev/zero", `of=${benchPath}`, `bs=${bs}`, `count=${count}`, "conv=fsync"],
    45_000
  );
  const writeSeconds = Math.max((Date.now() - writeStart) / 1000, 0.001);
  if (write.exitCode !== 0) {
    await runCmd(["rm", "-f", benchPath], 5_000);
    return {
      err: write.stderr || write.stdout || `write benchmark failed (${write.exitCode})`,
    };
  }

  const readStart = Date.now();
  const read = await runCmd(["dd", `if=${benchPath}`, "of=/dev/null", `bs=${bs}`], 45_000);
  const readSeconds = Math.max((Date.now() - readStart) / 1000, 0.001);
  await runCmd(["rm", "-f", benchPath], 5_000);
  if (read.exitCode !== 0) {
    return {
      err: read.stderr || read.stdout || `read benchmark failed (${read.exitCode})`,
    };
  }

  return {
    writeMbps: BENCH_SIZE_MIB / writeSeconds,
    readMbps: BENCH_SIZE_MIB / readSeconds,
  };
}

function parseMd2Status(mdstat: string): Md2Status {
  const normalized = mdstat.toLowerCase();
  const md2BlockMatch = /md2[\s\S]{0,500}/m.exec(normalized);
  if (!md2BlockMatch) return { resyncActive: false };
  const md2Block = md2BlockMatch[0];

  const active = md2Block.includes("resync") || md2Block.includes("recovery");
  const pctMatch = /(?:resync|recovery)\s*=\s*([0-9]+(?:\.[0-9]+)?)%/m.exec(md2Block);
  const progress = pctMatch?.[1] ? Number.parseFloat(pctMatch[1]) : undefined;

  return {
    resyncActive: active,
    progressPct: Number.isFinite(progress) ? progress : undefined,
  };
}

async function fetchMd2Status(): Promise<Md2Status> {
  const result = await runCmd(
    ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "joel@three-body", "cat /proc/mdstat"],
    7_000
  );
  if (result.exitCode !== 0) return { resyncActive: false };
  return parseMd2Status(result.stdout);
}

async function sampleMount(dest: string, source: string): Promise<MountSample> {
  const errors: string[] = [];
  const mounted = await isMounted(dest);
  if (!mounted) {
    errors.push("mount missing");
    return {
      mount: dest,
      source,
      mounted: false,
      accessOk: false,
      writeOk: false,
      errors,
    };
  }

  const access = await quickAccess(dest);
  if (!access.ok && access.err) errors.push(`access: ${access.err}`);

  const write = await quickWrite(dest);
  if (!write.ok && write.err) errors.push(`write: ${write.err}`);

  const bench = await benchReadWrite(dest);
  if (bench.err) errors.push(`bench: ${bench.err}`);

  return {
    mount: dest,
    source,
    mounted: true,
    accessOk: access.ok,
    writeOk: write.ok,
    writeMbps: bench.writeMbps,
    readMbps: bench.readMbps,
    errors,
  };
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function formatNum(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(1) : "n/a";
}

async function storeSample(sample: SoakSample): Promise<void> {
  const redis = getRedis();
  await redis.lpush(SAMPLES_KEY, JSON.stringify(sample));
  await redis.ltrim(SAMPLES_KEY, 0, SAMPLE_KEEP_COUNT - 1);
  await redis.expire(SAMPLES_KEY, SAMPLE_RETENTION_SECONDS);
}

async function loadSamples(): Promise<SoakSample[]> {
  const redis = getRedis();
  const rows = await redis.lrange(SAMPLES_KEY, 0, SAMPLE_KEEP_COUNT - 1);
  const parsed: SoakSample[] = [];
  const oldestAllowedTs = Date.now() - SAMPLE_RETENTION_SECONDS * 1000;
  for (const row of rows) {
    try {
      const sample = JSON.parse(row) as SoakSample;
      if (
        typeof sample?.ts === "number" &&
        sample.ts >= oldestAllowedTs &&
        Array.isArray(sample.mounts)
      ) {
        parsed.push(sample);
      }
    } catch {
      // ignore malformed samples
    }
  }
  return parsed;
}

export const nasSoakSample = inngest.createFunction(
  {
    id: "nas/soak-sample",
    name: "NAS Soak Sample (ADR-0088 gate telemetry)",
    concurrency: { limit: 1 },
    retries: 1,
  },
  [{ cron: "*/30 * * * *" }],
  async ({ step }) => {
    const md2 = await step.run("check-md2", async () => fetchMd2Status());

    const mountsRaw = await step.run("sample-mounts", async () =>
      Promise.all([
        sampleMount(NAS_NVME_MOUNT, NAS_NVME_SRC),
        sampleMount(THREE_BODY_MOUNT, THREE_BODY_SRC),
      ])
    );
    const mounts = mountsRaw
      .map((m) => normalizeMountSample(m))
      .filter((m): m is MountSample => m !== null);

    const sample: SoakSample = {
      ts: Date.now(),
      isoTime: new Date().toISOString(),
      md2ResyncActive: md2.resyncActive,
      md2ProgressPct: md2.progressPct,
      mounts,
    };

    await step.run("store-sample", async () => {
      await storeSample(sample);
    });

    const failed = mounts.some((m) => m.errors.length > 0);
    return {
      status: failed ? "degraded" : "ok",
      ts: sample.isoTime,
      md2ResyncActive: sample.md2ResyncActive,
      md2ProgressPct: sample.md2ProgressPct,
      mounts: mounts.map((m) => ({
        mount: m.mount,
        writeMbps: m.writeMbps,
        readMbps: m.readMbps,
        errorCount: m.errors.length,
      })),
    };
  }
);

export const nasSoakReview = inngest.createFunction(
  {
    id: "nas/soak-review",
    name: "NAS Soak Review (ADR-0088 gate evaluation)",
    concurrency: { limit: 1 },
    retries: 1,
  },
  [{ cron: "15 16 * * *" }, { event: "nas/soak.review.requested" }],
  async ({ step, gateway }) => {
    const samples = await step.run("load-samples", async () => loadSamples());

    const now = Date.now();
    const windowStart = now - GATE_MIN_SAMPLE_HOURS * 60 * 60 * 1000;
    const inWindow = samples.filter((s) => s.ts >= windowStart);

    const failures = inWindow.flatMap((s) =>
      s.mounts
        .filter((m) => m.errors.length > 0)
        .map((m) => ({ ts: s.ts, mount: m.mount, errors: m.errors }))
    );

    const nvmeWrites = inWindow
      .flatMap((s) => s.mounts.filter((m) => m.mount === NAS_NVME_MOUNT).map((m) => m.writeMbps))
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));

    const nvmeReads = inWindow
      .flatMap((s) => s.mounts.filter((m) => m.mount === NAS_NVME_MOUNT).map((m) => m.readMbps))
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));

    const medianWrite = median(nvmeWrites);
    const medianRead = median(nvmeReads);
    const latest = inWindow[0] ?? samples[0];

    const oldestWindowSample = inWindow.at(-1);
    const gateSampleWindow = oldestWindowSample
      ? (now - oldestWindowSample.ts) / (1000 * 60 * 60)
      : 0;
    const hasWindow = inWindow.length > 0 && gateSampleWindow <= GATE_MIN_SAMPLE_HOURS + 1;
    const gateZeroFailures = hasWindow && failures.length === 0;
    const gateResyncDone = latest ? !latest.md2ResyncActive : false;
    const gateWritePerf = typeof medianWrite === "number" && medianWrite >= GATE_MIN_WRITE_MBPS;
    const allGatesPass = gateZeroFailures && gateResyncDone && gateWritePerf;
    const gateCode = `G1:${gateZeroFailures ? "PASS" : "FAIL"} G2:${gateResyncDone ? "PASS" : "FAIL"} G3:${gateWritePerf ? "PASS" : "FAIL"}`;
    const overallCode = allGatesPass ? "PASS" : "FAIL";
    const compactCode = `ADR88 ${overallCode} ${gateCode}`;

    const suggestions: string[] = [];
    if (!gateResyncDone) suggestions.push("Wait for md2 resync/recovery completion before deciding on live NAS primary.");
    if (!gateZeroFailures) suggestions.push("Keep local SSD as Typesense primary; investigate mount/access errors before migration.");
    if (!gateWritePerf) suggestions.push(`Re-test when idle; median NAS write ${formatNum(medianWrite)} MiB/s is below gate ${GATE_MIN_WRITE_MBPS} MiB/s.`);
    if (allGatesPass) suggestions.push("Proceed to controlled restore drill, then decide whether to pilot live Typesense on NAS.");

    await step.run("notify-gateway", async () => {
      const summary = [
        "## 🧪 NAS Soak Review (ADR-0088 Gate)",
        "",
        `- Code: \`${compactCode}\``,
        `- Samples (48h window): ${inWindow.length}`,
        `- Failures: ${failures.length}`,
        `- md2 resync active: ${latest?.md2ResyncActive ? "yes" : "no"}${typeof latest?.md2ProgressPct === "number" ? ` (${latest.md2ProgressPct.toFixed(1)}%)` : ""}`,
        `- Median /Volumes/nas-nvme write: ${formatNum(medianWrite)} MiB/s`,
        `- Median /Volumes/nas-nvme read: ${formatNum(medianRead)} MiB/s`,
        "",
        `- Gate: zero-failures-48h = ${gateZeroFailures ? "PASS" : "FAIL"}`,
        `- Gate: md2-resync-complete = ${gateResyncDone ? "PASS" : "FAIL"}`,
        `- Gate: write>=${GATE_MIN_WRITE_MBPS}MiB/s = ${gateWritePerf ? "PASS" : "FAIL"}`,
        "",
        `- Overall: ${allGatesPass ? "PASS" : "FAIL"}`,
        "",
        "### Suggested Next Steps",
        ...suggestions.map((s) => `- ${s}`),
      ];

      await gateway.notify("nas.soak.review", {
        message: summary.join("\n"),
        gatePass: allGatesPass,
        code: compactCode,
        overallCode,
        gateCode,
        samples: inWindow.length,
        failures: failures.length,
        medianWriteMbps: medianWrite,
        medianReadMbps: medianRead,
      });
    });

    if (!allGatesPass) {
      await step.run("upsert-taskport-todo", async () => {
        const adapter = new TodoistTaskAdapter();
        const existing = await adapter.listTasks({ label: REVIEW_TASK_LABEL });
        const alreadyTracked = existing.some((t) => t.content.toLowerCase().includes("nas soak gate"));
        if (alreadyTracked) return { created: false };

        await adapter.createTask({
          content: "NAS soak gate failing (ADR-0088) — investigate and decide next step",
          description: [
            `Samples(48h): ${inWindow.length}`,
            `Failures: ${failures.length}`,
            `md2 resync active: ${latest?.md2ResyncActive ? "yes" : "no"}`,
            `Median /Volumes/nas-nvme write MiB/s: ${formatNum(medianWrite)}`,
            `Median /Volumes/nas-nvme read MiB/s: ${formatNum(medianRead)}`,
            "",
            "ADR-0088 revisit gates failing. Keep local Typesense primary and investigate mounts/perf.",
          ].join("\n"),
          labels: ["agent", REVIEW_TASK_LABEL],
          projectId: REVIEW_TASK_PROJECT,
        });
        return { created: true };
      });
    }

    return {
      status: allGatesPass ? "pass" : "fail",
      samples: inWindow.length,
      failures: failures.length,
      medianWriteMbps: medianWrite,
      medianReadMbps: medianRead,
      gateZeroFailures,
      gateResyncDone,
      gateWritePerf,
      suggestions,
    };
  }
);
