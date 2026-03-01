import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";

const INNGEST_RUNTIME_HEALING_DOMAIN = "inngest-runtime";
const INNGEST_RUNTIME_HEALTH_EVENT = "system/inngest.runtime.health.requested";
const SELF_HEALING_REQUEST_EVENT = "system/self.healing.requested";
const INNGEST_STATUS_CMD = ["joelclaw", "inngest", "status"] as const;
const INNGEST_RESTART_CMD = [
  "joelclaw",
  "inngest",
  "restart-worker",
  "--register",
  "--wait-ms",
  "1500",
] as const;

type InngestRuntimeRequest = {
  domain?: string;
  dryRun?: boolean;
  attempt?: number;
  sourceFunction?: string;
  targetComponent?: string;
  targetEventName?: string;
  problemSummary?: string;
};

type CliCommandResult = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  parsed: unknown | null;
  parseSource: "stdout" | "stderr" | "combined" | "none";
  durationMs: number;
};

type InngestCheckSummary = {
  name: string;
  ok: boolean;
  detail: string;
};

type InngestRuntimeHealthSummary = {
  healthy: boolean;
  degradedChecks: string[];
  checks: InngestCheckSummary[];
  parseError?: string;
  workerReachable: boolean | null;
  registeredFunctionCount: number | null;
};

type InngestRuntimeFlowContext = {
  runContextKey: string;
  flowTrace: string[];
  sourceEventName: string;
  sourceEventId?: string;
  attempt: number;
};

function toSafeText(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function toSafeInt(value: unknown, fallback: number, min = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(min, Math.floor(value));
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return Math.max(min, parsed);
  }
  return fallback;
}

function toSafeBool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function trimForMetadata(value: unknown, max = 220): string {
  if (typeof value !== "string") return "";
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, Math.max(max - 3, 1))}...`;
}

function toText(value: Buffer | Uint8Array | string | undefined): string {
  if (typeof value === "string") return value.trim();
  if (!value) return "";
  return Buffer.from(value).toString("utf8").trim();
}

function parseJsonFromText(raw: string): unknown | null {
  if (!raw) return null;

  const trimmed = raw.trim();
  const parse = (candidate: string): unknown | null => {
    try {
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  };

  const direct = parse(trimmed);
  if (direct !== null) return direct;

  const fenced = trimmed.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    const fencedValue = parse(fenced[1].trim());
    if (fencedValue !== null) return fencedValue;
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    return parse(trimmed.slice(start, end + 1));
  }

  return null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function normalizeChecks(input: unknown): InngestCheckSummary[] {
  const record = asObject(input);
  if (!record) return [];

  const checks: InngestCheckSummary[] = [];
  for (const [name, value] of Object.entries(record)) {
    const parsed = asObject(value);
    if (!parsed) continue;
    checks.push({
      name,
      ok: parsed.ok === true,
      detail: toSafeText(parsed.detail, ""),
    });
  }

  return checks.sort((a, b) => a.name.localeCompare(b.name));
}

function runCliCommand(args: readonly string[]): CliCommandResult {
  const startedAt = Date.now();
  const proc = Bun.spawnSync([...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = toText(proc.stdout);
  const stderr = toText(proc.stderr);

  const stdoutParsed = parseJsonFromText(stdout);
  const stderrParsed = parseJsonFromText(stderr);
  const combinedParsed = parseJsonFromText(`${stdout}\n${stderr}`);

  let parsed: unknown | null = null;
  let parseSource: CliCommandResult["parseSource"] = "none";

  if (stdoutParsed !== null) {
    parsed = stdoutParsed;
    parseSource = "stdout";
  } else if (stderrParsed !== null) {
    parsed = stderrParsed;
    parseSource = "stderr";
  } else if (combinedParsed !== null) {
    parsed = combinedParsed;
    parseSource = "combined";
  }

  return {
    command: args.join(" "),
    exitCode: proc.exitCode ?? 1,
    stdout,
    stderr,
    parsed,
    parseSource,
    durationMs: Date.now() - startedAt,
  };
}

function parseInngestHealth(command: CliCommandResult): InngestRuntimeHealthSummary {
  const parsedRoot = asObject(command.parsed);

  if (!parsedRoot) {
    return {
      healthy: false,
      degradedChecks: [],
      checks: [],
      parseError: "Unable to parse `joelclaw inngest status` output as JSON",
      workerReachable: null,
      registeredFunctionCount: null,
    };
  }

  const resultNode = asObject(parsedRoot.result) ?? parsedRoot;
  const checks = normalizeChecks(resultNode.checks ?? parsedRoot.checks);

  const requiredNames = new Set(["server", "worker"]);
  const requiredChecks = checks.filter((check) => requiredNames.has(check.name.toLowerCase()));
  const degradedRequiredChecks = requiredChecks.filter((check) => !check.ok).map((check) => check.name);

  const worker = asObject(resultNode.worker);
  const workerReachable = typeof worker?.reachable === "boolean" ? worker.reachable : null;

  const registeredFunctionCount = typeof resultNode.registeredFunctionCount === "number"
    ? resultNode.registeredFunctionCount
    : null;

  const envelopeOk = typeof parsedRoot.ok === "boolean" ? parsedRoot.ok : null;

  let healthy: boolean;
  if (requiredChecks.length > 0) {
    healthy = degradedRequiredChecks.length === 0;
  } else if (envelopeOk !== null) {
    healthy = envelopeOk;
  } else {
    healthy = command.exitCode === 0;
  }

  if (workerReachable === false) {
    healthy = false;
  }

  const degradedChecks = requiredChecks.length > 0
    ? degradedRequiredChecks
    : checks.filter((check) => !check.ok).map((check) => check.name);

  return {
    healthy,
    degradedChecks,
    checks,
    workerReachable,
    registeredFunctionCount,
    parseError: healthy ? undefined : command.parseSource === "none"
      ? "Missing parseable status payload"
      : undefined,
  };
}

function summarizeCommand(command: CliCommandResult): Record<string, unknown> {
  return {
    command: command.command,
    exitCode: command.exitCode,
    durationMs: command.durationMs,
    parseSource: command.parseSource,
    stdout: trimForMetadata(command.stdout, 340),
    stderr: trimForMetadata(command.stderr, 340),
  };
}

function summarizeHealth(health: InngestRuntimeHealthSummary): Record<string, unknown> {
  return {
    healthy: health.healthy,
    degradedChecks: health.degradedChecks,
    workerReachable: health.workerReachable,
    registeredFunctionCount: health.registeredFunctionCount,
    parseError: health.parseError,
    checks: health.checks.map((check) => ({
      name: check.name,
      ok: check.ok,
      detail: trimForMetadata(check.detail, 160),
    })),
  };
}

function buildInngestRuntimeFlowContext(input: {
  sourceFunction: string;
  targetComponent: string;
  targetEventName: string;
  domain: string;
  eventName: string;
  eventId: string | undefined;
  attempt: number;
}): InngestRuntimeFlowContext {
  const sourceFunction = toSafeText(input.sourceFunction, "system/self-healing.router");
  const targetComponent = toSafeText(input.targetComponent, "inngest-runtime");
  const domain = toSafeText(input.domain, INNGEST_RUNTIME_HEALING_DOMAIN);
  const eventName = toSafeText(input.eventName, INNGEST_RUNTIME_HEALTH_EVENT);
  const targetEventName = toSafeText(input.targetEventName, INNGEST_RUNTIME_HEALTH_EVENT);
  const attempt = Math.max(0, Math.floor(input.attempt));

  return {
    runContextKey: `${eventName}::${sourceFunction}::${targetComponent}::${domain}::${targetEventName}::a${attempt}`,
    flowTrace: [
      eventName,
      sourceFunction,
      targetComponent,
      domain,
      targetEventName,
      `attempt:${attempt}`,
    ],
    sourceEventName: eventName,
    sourceEventId: input.eventId,
    attempt,
  };
}

export const selfHealingInngestRuntime = inngest.createFunction(
  {
    id: "system/self-healing.inngest-runtime",
    name: "Self-heal Inngest Runtime Health",
    concurrency: { limit: 1 },
    retries: 1,
  },
  [
    { cron: "TZ=America/Los_Angeles */10 * * * *" },
    { event: INNGEST_RUNTIME_HEALTH_EVENT },
    { event: SELF_HEALING_REQUEST_EVENT },
  ],
  async ({ event, step }) => {
    const data = (event.data ?? {}) as InngestRuntimeRequest;
    const sourceEventName = event.name;
    const requestedDomain = toSafeText(data.domain, "").toLowerCase();
    const isSelfHealingRequest = sourceEventName === SELF_HEALING_REQUEST_EVENT;
    const isRuntimeHealthRequest = sourceEventName === INNGEST_RUNTIME_HEALTH_EVENT;

    const shouldRun = isRuntimeHealthRequest
      || !isSelfHealingRequest
      || requestedDomain === INNGEST_RUNTIME_HEALING_DOMAIN
      || requestedDomain === "all";

    if (!shouldRun) {
      return {
        status: "skipped",
        reason: `unsupported domain ${toSafeText(data.domain, "unknown")}`,
      };
    }

    const dryRun = toSafeBool(data.dryRun, false);
    const attempt = toSafeInt(data.attempt, 0, 0);
    const nextAttempt = attempt + 1;
    const sourceFunction = toSafeText(data.sourceFunction, "system/self-healing.router");
    const targetComponent = toSafeText(data.targetComponent, "inngest-runtime");
    const targetEventName = toSafeText(data.targetEventName, INNGEST_RUNTIME_HEALTH_EVENT);
    const problemSummary = toSafeText(data.problemSummary, "Inngest runtime health check requested.");
    const flowContext = buildInngestRuntimeFlowContext({
      sourceFunction,
      targetComponent,
      targetEventName,
      domain: INNGEST_RUNTIME_HEALING_DOMAIN,
      eventName: sourceEventName,
      eventId: event.id,
      attempt,
    });

    const statusBeforeCommand = await step.run("probe-inngest-status-before", async () =>
      runCliCommand(INNGEST_STATUS_CMD)
    );
    const before = parseInngestHealth(statusBeforeCommand);

    let remediationAttempted = false;
    let restartCommand: CliCommandResult | null = null;
    let statusAfterCommand: CliCommandResult | null = null;
    let after = before;

    if (!before.healthy && !dryRun) {
      remediationAttempted = true;
      restartCommand = await step.run("restart-inngest-worker", async () =>
        runCliCommand(INNGEST_RESTART_CMD)
      );
      statusAfterCommand = await step.run("probe-inngest-status-after", async () =>
        runCliCommand(INNGEST_STATUS_CMD)
      );
      after = parseInngestHealth(statusAfterCommand);
    }

    const remediated = !before.healthy && remediationAttempted && after.healthy;
    const status = before.healthy
      ? "healthy"
      : dryRun
        ? "detected"
        : remediated
          ? "remediated"
          : "degraded";

    const success = status === "healthy" || status === "remediated";

    await emitOtelEvent({
      level: success ? "info" : "warn",
      source: "worker",
      component: "self-healing",
      action: "system.self-healing.inngest-runtime.health",
      success,
      error: success
        ? undefined
        : before.degradedChecks.length > 0
          ? before.degradedChecks.join(", ")
          : before.parseError ?? "Inngest runtime degraded",
      metadata: {
        domain: INNGEST_RUNTIME_HEALING_DOMAIN,
        status,
        dryRun,
        attempt,
        nextAttempt,
        sourceFunction,
        targetComponent,
        targetEventName,
        problemSummary: trimForMetadata(problemSummary, 220),
        runContext: {
          runContextKey: flowContext.runContextKey,
          flowTrace: flowContext.flowTrace,
          sourceEventName: flowContext.sourceEventName,
          sourceEventId: flowContext.sourceEventId,
          attempt: flowContext.attempt,
          nextAttempt,
        },
        remediation: {
          attempted: remediationAttempted,
          remediated,
          restartCommand: restartCommand ? summarizeCommand(restartCommand) : null,
        },
        statusBefore: summarizeHealth(before),
        statusAfter: summarizeHealth(after),
        commands: {
          statusBefore: summarizeCommand(statusBeforeCommand),
          statusAfter: statusAfterCommand ? summarizeCommand(statusAfterCommand) : null,
        },
        playbook: {
          status: "joelclaw inngest status",
          restart: "joelclaw inngest restart-worker --register --wait-ms 1500",
        },
      },
    });

    return {
      status,
      domain: INNGEST_RUNTIME_HEALING_DOMAIN,
      sourceEventName,
      dryRun,
      attempt,
      nextAttempt,
      remediationAttempted,
      remediated,
      before,
      after,
      restartExitCode: restartCommand?.exitCode ?? null,
    };
  },
);
