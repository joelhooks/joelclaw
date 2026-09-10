import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { createActor, createMachine } from "xstate";

export type GatewayAlertKind = "missing" | "stale";
export type GatewayAlertPhase =
  | "idle"
  | "ensuringHerdr"
  | "openingWorkspace"
  | "startingAgent"
  | "promptingAgent"
  | "investigating"
  | "blocked"
  | "recovering"
  | "recoveryBlocked"
  | "recovered";

export type GatewayAlertIncident = {
  readonly version: 1;
  readonly phase: GatewayAlertPhase;
  readonly incidentId: string;
  readonly kind: GatewayAlertKind;
  readonly ageSeconds?: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly attempt: number;
  readonly attemptStartedAt: string;
  readonly retryAfter?: string;
  readonly workspaceId?: string;
  readonly paneId?: string;
  readonly agentName?: string;
  readonly lastError?: string;
  readonly recoveredAt?: string;
};

type GatewayAlertEvent =
  | { readonly type: "ALERT" }
  | { readonly type: "HERDR_READY" }
  | { readonly type: "WORKSPACE_READY" }
  | { readonly type: "AGENT_READY" }
  | { readonly type: "PROMPT_ACCEPTED" }
  | { readonly type: "FAILED" }
  | { readonly type: "RETRY" }
  | { readonly type: "WORKSPACE_LOST" }
  | { readonly type: "AGENT_LOST" }
  | { readonly type: "BEGIN_RECOVERY" }
  | { readonly type: "RECOVERY_DELIVERED" }
  | { readonly type: "RECOVERY_FAILED" }
  | { readonly type: "RETRY_RECOVERY" };

export const gatewayAlertInvestigatorMachine = createMachine({
  id: "gatewayAlertInvestigator",
  initial: "idle",
  states: {
    idle: { on: { ALERT: "ensuringHerdr" } },
    ensuringHerdr: {
      on: { HERDR_READY: "openingWorkspace", FAILED: "blocked", BEGIN_RECOVERY: "recovering" },
    },
    openingWorkspace: {
      on: { WORKSPACE_READY: "startingAgent", FAILED: "blocked", BEGIN_RECOVERY: "recovering" },
    },
    startingAgent: {
      on: { AGENT_READY: "promptingAgent", FAILED: "blocked", BEGIN_RECOVERY: "recovering" },
    },
    promptingAgent: {
      on: { PROMPT_ACCEPTED: "investigating", FAILED: "blocked", BEGIN_RECOVERY: "recovering" },
    },
    investigating: {
      on: {
        ALERT: "investigating",
        WORKSPACE_LOST: "ensuringHerdr",
        AGENT_LOST: "startingAgent",
        BEGIN_RECOVERY: "recovering",
      },
    },
    blocked: {
      on: { ALERT: "blocked", RETRY: "ensuringHerdr", BEGIN_RECOVERY: "recovering" },
    },
    recovering: {
      on: {
        RECOVERY_DELIVERED: "recovered",
        RECOVERY_FAILED: "recoveryBlocked",
        ALERT: "ensuringHerdr",
      },
    },
    recoveryBlocked: {
      on: { RETRY_RECOVERY: "recovering", ALERT: "ensuringHerdr" },
    },
    recovered: { on: { ALERT: "ensuringHerdr" } },
  },
});

export type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type CommandRunner = (input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
}) => Promise<CommandResult>;

export type GatewayAlertInvestigatorOptions = {
  readonly statePath?: string;
  readonly repoRoot?: string;
  readonly herdrBin?: string;
  readonly launchctlBin?: string;
  readonly joelclawBin?: string;
  readonly model?: string;
  readonly modelsPath?: string;
  readonly retryMs?: number;
  readonly commandRunner?: CommandRunner;
  readonly modelProbe?: (model: string) => Promise<void>;
  readonly insideHerdr?: boolean;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
};

export type GatewayAlertResult = {
  readonly ok: boolean;
  readonly action: "started" | "existing" | "blocked" | "recovered" | "idle";
  readonly incident?: GatewayAlertIncident;
};

const DEFAULT_STATE_PATH = resolve(
  homedir(),
  ".local/state/joelclaw/gateway-alert-investigator.json",
);
const DEFAULT_REPO_ROOT = resolve(homedir(), "Code/joelhooks/joelclaw");
const DEFAULT_MODEL = "dgx-glm/glm-5.3-flash:high";
const DEFAULT_MODELS_PATH = resolve(homedir(), ".pi/agent/models.json");
const DEFAULT_RETRY_MS = 5 * 60_000;
const LOCK_STALE_MS = 2 * 60_000;
const LOCK_HEARTBEAT_MS = 10_000;

function transitionIncident(
  incident: GatewayAlertIncident,
  event: GatewayAlertEvent,
  patch: Partial<GatewayAlertIncident> = {},
): GatewayAlertIncident {
  const actor = createActor(gatewayAlertInvestigatorMachine, {
    snapshot: gatewayAlertInvestigatorMachine.resolveState({
      value: incident.phase,
      context: {},
    }),
  }).start();
  actor.send(event);
  const phase = String(actor.getSnapshot().value) as GatewayAlertPhase;
  actor.stop();
  return { ...incident, ...patch, phase };
}

function cleanDefaultHerdrEnvironment(): Record<string, string | undefined> {
  const env = { ...process.env };
  delete env.HERDR_SESSION;
  delete env.HERDR_SOCKET;
  return env;
}

async function defaultCommandRunner(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
}): Promise<CommandResult> {
  const processHandle = Bun.spawn([input.command, ...input.args], {
    cwd: input.cwd,
    env: input.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      processHandle.kill();
      reject(new Error(`Command timed out: ${input.command}`));
    }, input.timeoutMs ?? 30_000);
  });
  try {
    const exitCode = await Promise.race([processHandle.exited, timeoutPromise]);
    const [stdout, stderr] = await Promise.all([
      new Response(processHandle.stdout).text(),
      new Response(processHandle.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function probeConfiguredModel(model: string, modelsPath: string): Promise<void> {
  const slash = model.indexOf("/");
  if (slash < 1) throw new Error(`Model has no provider prefix: ${model}`);
  const providerId = model.slice(0, slash);
  const modelId = model.slice(slash + 1).replace(/:(off|minimal|low|medium|high|xhigh|max)$/, "");
  const config = JSON.parse(await readFile(modelsPath, "utf8")) as {
    readonly providers?: Readonly<
      Record<
        string,
        {
          readonly baseUrl?: string;
          readonly apiKey?: string;
        }
      >
    >;
  };
  const provider = config.providers?.[providerId];
  if (!provider?.baseUrl) throw new Error(`No base URL configured for ${providerId}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/models`, {
      headers: provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : undefined,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`${providerId} model probe returned HTTP ${response.status}`);
    }
    const body = (await response.json()) as {
      readonly data?: ReadonlyArray<{ readonly id?: string }>;
    };
    if (!body.data?.some((candidate) => candidate.id === modelId)) {
      throw new Error(`${providerId} did not advertise ${modelId}`);
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`${providerId} model probe timed out`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function parseHerdrResult(stdout: string): Record<string, unknown> {
  const parsed = JSON.parse(stdout) as { readonly result?: Record<string, unknown> };
  if (!parsed.result || typeof parsed.result !== "object") {
    throw new Error("Herdr returned no result object");
  }
  return parsed.result;
}

async function readIncident(path: string): Promise<GatewayAlertIncident | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as GatewayAlertIncident;
    if (parsed.version !== 1 || typeof parsed.phase !== "string") {
      throw new Error(`Unsupported gateway alert state at ${path}`);
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeIncident(path: string, incident: GatewayAlertIncident): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(incident, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function lockAgeMs(lockPath: string): Promise<number> {
  try {
    const owner = JSON.parse(await readFile(resolve(lockPath, "owner.json"), "utf8")) as {
      readonly heartbeatFile?: string;
    };
    if (owner.heartbeatFile?.match(/^heartbeat-[0-9a-f-]+$/)) {
      return Date.now() - (await stat(resolve(lockPath, owner.heartbeatFile))).mtimeMs;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return Date.now() - (await stat(lockPath)).mtimeMs;
    }
  }
  return Date.now() - (await stat(lockPath)).mtimeMs;
}

async function withFileLock<T>(path: string, run: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  await mkdir(dirname(lockPath), { recursive: true });
  const startedAt = Date.now();
  let heartbeatPath: string | undefined;
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      const heartbeatFile = `heartbeat-${randomUUID()}`;
      heartbeatPath = resolve(lockPath, heartbeatFile);
      try {
        await writeFile(heartbeatPath, "", { encoding: "utf8", mode: 0o600 });
        await writeFile(
          resolve(lockPath, "owner.json"),
          `${JSON.stringify({
            pid: process.pid,
            createdAt: new Date().toISOString(),
            heartbeatFile,
          })}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if ((await lockAgeMs(lockPath)) > LOCK_STALE_MS) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() - startedAt > 10_000) {
        throw new Error(`Timed out acquiring gateway alert lock ${lockPath}`);
      }
      await wait(25);
    }
  }

  const heartbeat = setInterval(() => {
    if (!heartbeatPath) return;
    const now = new Date();
    void utimes(heartbeatPath, now, now).catch(() => undefined);
  }, LOCK_HEARTBEAT_MS);
  heartbeat.unref();
  try {
    return await run();
  } finally {
    clearInterval(heartbeat);
    await rm(lockPath, { recursive: true, force: true });
  }
}

function incidentName(incidentId: string): string {
  return `gateway_alert_${incidentId.replaceAll("-", "").slice(0, 12)}`;
}

function workspaceLabel(kind: GatewayAlertKind): string {
  const problem = kind === "missing" ? "heartbeat missing" : "heartbeat stale";
  return `[jc] gateway ${problem} · GLM investigating`;
}

function incidentWorkspaceLabel(incident: GatewayAlertIncident): string {
  return `${workspaceLabel(incident.kind)} · ${incident.incidentId.slice(0, 8)}`;
}

function investigationPrompt(incident: GatewayAlertIncident): string {
  const age = incident.ageSeconds === undefined ? "unknown" : `${incident.ageSeconds} seconds`;
  return `The local gateway tripwire detected a ${incident.kind} heartbeat at ${incident.createdAt}. Heartbeat age: ${age}.

Own this incident. Diagnose it and make safe, reversible repairs. Use the normal project and fleet instructions already loaded in this Pi session.

Start with the supported gateway surface:
- joelclaw gateway doctor --json
- joelclaw gateway status

Hard boundaries:
- Never start a second gateway, Telegram poller, Slack socket, Discord listener, or comms transport.
- Use joelclaw gateway commands for gateway lifecycle changes. Do not manipulate its launchd job directly.
- Do not send a live canary or any outward message without Joel's explicit approval.
- Do not print secrets or credentials.
- Do not use broad process-name kills.
- Preserve dirty work and shared history.

Find the root cause. Repair it when the action is safe and reversible. Verify the heartbeat, readiness file, gateway doctor, and the dependency that failed. Keep this Herdr workspace label current. Finish with root cause, changes, verification, and remaining blockers.`;
}

function recoveryPrompt(recoveredAt: string): string {
  return `The gateway heartbeat recovered at ${recoveredAt}. Verify current health with the supported gateway commands. Summarize the root cause, any changes you made, and the final checks. Leave the workspace ready for review.`;
}

export class GatewayAlertInvestigator {
  private readonly statePath: string;
  private readonly repoRoot: string;
  private readonly herdrBin: string;
  private readonly launchctlBin: string;
  private readonly joelclawBin: string;
  private readonly model: string;
  private readonly retryMs: number;
  private readonly runCommand: CommandRunner;
  private readonly probeModel: (model: string) => Promise<void>;
  private readonly insideHerdr: boolean;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly herdrEnv: Readonly<Record<string, string | undefined>>;

  constructor(options: GatewayAlertInvestigatorOptions = {}) {
    this.statePath = options.statePath ?? DEFAULT_STATE_PATH;
    this.repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
    this.herdrBin = options.herdrBin ?? resolve(homedir(), ".local/bin/herdr");
    this.launchctlBin = options.launchctlBin ?? "/bin/launchctl";
    this.joelclawBin = options.joelclawBin ?? resolve(homedir(), ".local/bin/joelclaw");
    this.model = options.model ?? DEFAULT_MODEL;
    this.retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
    this.runCommand = options.commandRunner ?? defaultCommandRunner;
    const modelsPath = options.modelsPath ?? DEFAULT_MODELS_PATH;
    this.probeModel = options.modelProbe ?? ((model) => probeConfiguredModel(model, modelsPath));
    this.insideHerdr = options.insideHerdr ?? Boolean(process.env.HERDR_PANE_ID);
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? wait;
    this.herdrEnv = cleanDefaultHerdrEnvironment();
  }

  async alert(kind: GatewayAlertKind, ageSeconds?: number): Promise<GatewayAlertResult> {
    return withFileLock(this.statePath, async () => {
      const existing = await readIncident(this.statePath);
      const now = this.now();
      let incident: GatewayAlertIncident;

      if (!existing || existing.phase === "idle" || existing.phase === "recovered") {
        const incidentId = crypto.randomUUID();
        const initial: GatewayAlertIncident = {
          version: 1,
          phase: existing?.phase ?? "idle",
          incidentId,
          kind,
          ...(ageSeconds === undefined ? {} : { ageSeconds }),
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          attempt: 1,
          attemptStartedAt: now.toISOString(),
          agentName: incidentName(incidentId),
        };
        incident = transitionIncident(
          initial,
          { type: "ALERT" },
          {
            workspaceId: undefined,
            paneId: undefined,
            lastError: undefined,
            retryAfter: undefined,
            recoveredAt: undefined,
          },
        );
        await writeIncident(this.statePath, incident);
      } else if (existing.phase === "investigating") {
        incident = transitionIncident(
          existing,
          { type: "ALERT" },
          {
            kind,
            ...(ageSeconds === undefined ? {} : { ageSeconds }),
            updatedAt: now.toISOString(),
          },
        );
        if (incident.workspaceId && (await this.workspaceExists(incident.workspaceId))) {
          if (existing.kind !== kind) {
            await this.runHerdr([
              "workspace",
              "rename",
              incident.workspaceId,
              workspaceLabel(kind),
            ]).catch(() => undefined);
          }
          if (incident.agentName && (await this.agentExists(incident.agentName))) {
            await writeIncident(this.statePath, incident);
            return { ok: true, action: "existing", incident };
          }
          incident = transitionIncident(
            incident,
            { type: "AGENT_LOST" },
            {
              agentName: incidentName(crypto.randomUUID()),
              updatedAt: now.toISOString(),
            },
          );
          await writeIncident(this.statePath, incident);
          return this.advance(incident);
        }
        incident = transitionIncident(
          incident,
          { type: "WORKSPACE_LOST" },
          { updatedAt: now.toISOString() },
        );
        await writeIncident(this.statePath, incident);
      } else if (existing.phase === "recovering" || existing.phase === "recoveryBlocked") {
        incident = transitionIncident(
          existing,
          { type: "ALERT" },
          {
            kind,
            ...(ageSeconds === undefined ? {} : { ageSeconds }),
            attemptStartedAt: now.toISOString(),
            updatedAt: now.toISOString(),
            attempt: existing.attempt + 1,
            lastError: undefined,
          },
        );
        await writeIncident(this.statePath, incident);
      } else if (existing.phase === "blocked") {
        const retryAt = existing.retryAfter ? Date.parse(existing.retryAfter) : 0;
        if (retryAt > now.getTime()) {
          return { ok: false, action: "blocked", incident: existing };
        }
        incident = transitionIncident(
          existing,
          { type: "RETRY" },
          {
            kind,
            ...(ageSeconds === undefined ? {} : { ageSeconds }),
            updatedAt: now.toISOString(),
            attemptStartedAt: now.toISOString(),
            attempt: existing.attempt + 1,
            retryAfter: undefined,
            lastError: undefined,
          },
        );
        await writeIncident(this.statePath, incident);
      } else {
        incident = {
          ...existing,
          kind,
          ...(ageSeconds === undefined ? {} : { ageSeconds }),
          updatedAt: now.toISOString(),
        };
      }

      return this.advance(incident);
    });
  }

  async recover(): Promise<GatewayAlertResult> {
    return withFileLock(this.statePath, async () => {
      const existing = await readIncident(this.statePath);
      if (!existing || existing.phase === "idle" || existing.phase === "recovered") {
        return { ok: true, action: "idle", incident: existing };
      }

      const recoveryStartedAt = this.now().toISOString();
      let recovering =
        existing.phase === "recovering"
          ? existing
          : transitionIncident(
              existing,
              { type: existing.phase === "recoveryBlocked" ? "RETRY_RECOVERY" : "BEGIN_RECOVERY" },
              {
                updatedAt: recoveryStartedAt,
                retryAfter: undefined,
                lastError: undefined,
              },
            );
      await writeIncident(this.statePath, recovering);

      try {
        await this.ensureDefaultHerdr();
        const workspace = await this.ensureWorkspace(recovering);
        recovering = {
          ...recovering,
          workspaceId: workspace.workspaceId,
          paneId: workspace.paneId,
          ...(workspace.created && recovering.workspaceId
            ? { agentName: incidentName(crypto.randomUUID()) }
            : {}),
          updatedAt: this.now().toISOString(),
        };
        await writeIncident(this.statePath, recovering);
        await this.probeModel(this.model);
        await this.ensureAgent(recovering);

        const renamed = await this.runHerdr([
          "workspace",
          "rename",
          workspace.workspaceId,
          "[jc] gateway recovered · review ready",
        ]);
        if (renamed.exitCode !== 0) {
          throw new Error(
            `Could not mark recovered workspace review-ready: ${renamed.stderr.trim()}`,
          );
        }
        if (!recovering.agentName) throw new Error("Recovered incident has no Herdr agent name");
        const prompted = await this.runHerdr([
          "agent",
          "prompt",
          recovering.agentName,
          recoveryPrompt(recoveryStartedAt),
        ]);
        if (prompted.exitCode !== 0) {
          throw new Error(`Could not request gateway recovery receipt: ${prompted.stderr.trim()}`);
        }

        const recovered = transitionIncident(
          recovering,
          { type: "RECOVERY_DELIVERED" },
          {
            updatedAt: this.now().toISOString(),
            recoveredAt: recoveryStartedAt,
            lastError: undefined,
          },
        );
        await writeIncident(this.statePath, recovered);
        await this.emitTelemetry("gateway_alert_investigator.recovered", recovered, true);
        return { ok: true, action: "recovered", incident: recovered };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const blocked = transitionIncident(
          recovering,
          { type: "RECOVERY_FAILED" },
          {
            updatedAt: this.now().toISOString(),
            lastError: message,
          },
        );
        await writeIncident(this.statePath, blocked);
        await this.emitTelemetry(
          "gateway_alert_investigator.recovery_failed",
          blocked,
          false,
          message,
        );
        return { ok: false, action: "blocked", incident: blocked };
      }
    });
  }

  private async advance(start: GatewayAlertIncident): Promise<GatewayAlertResult> {
    let incident = start;
    try {
      if (incident.phase === "ensuringHerdr") {
        await this.ensureDefaultHerdr();
        incident = transitionIncident(
          incident,
          { type: "HERDR_READY" },
          {
            updatedAt: this.now().toISOString(),
          },
        );
        await writeIncident(this.statePath, incident);
      }

      if (incident.phase === "openingWorkspace") {
        const workspace = await this.ensureWorkspace(incident);
        incident = transitionIncident(
          incident,
          { type: "WORKSPACE_READY" },
          {
            workspaceId: workspace.workspaceId,
            paneId: workspace.paneId,
            ...(workspace.created && incident.workspaceId
              ? { agentName: incidentName(crypto.randomUUID()) }
              : {}),
            updatedAt: this.now().toISOString(),
          },
        );
        await writeIncident(this.statePath, incident);
      }

      if (incident.phase === "startingAgent") {
        await this.probeModel(this.model);
        await this.ensureAgent(incident);
        incident = transitionIncident(
          incident,
          { type: "AGENT_READY" },
          {
            updatedAt: this.now().toISOString(),
          },
        );
        await writeIncident(this.statePath, incident);
      }

      if (incident.phase === "promptingAgent") {
        if (!incident.agentName) throw new Error("Incident has no Herdr agent name");
        const prompted = await this.runHerdr(
          ["agent", "prompt", incident.agentName, investigationPrompt(incident)],
          15_000,
        );
        if (prompted.exitCode !== 0) {
          throw new Error(`Herdr rejected investigator prompt: ${prompted.stderr.trim()}`);
        }
        incident = transitionIncident(
          incident,
          { type: "PROMPT_ACCEPTED" },
          {
            updatedAt: this.now().toISOString(),
          },
        );
        await writeIncident(this.statePath, incident);
        if (incident.workspaceId) {
          await this.runHerdr([
            "workspace",
            "rename",
            incident.workspaceId,
            workspaceLabel(incident.kind),
          ]).catch(() => undefined);
        }
        await this.emitTelemetry("gateway_alert_investigator.started", incident, true);
        return { ok: true, action: "started", incident };
      }

      if (incident.phase === "investigating") {
        return { ok: true, action: "existing", incident };
      }

      throw new Error(`Cannot advance gateway alert incident from ${incident.phase}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = transitionIncident(
        incident,
        { type: "FAILED" },
        {
          updatedAt: this.now().toISOString(),
          retryAfter: new Date(Date.parse(incident.attemptStartedAt) + this.retryMs).toISOString(),
          lastError: message,
        },
      );
      await writeIncident(this.statePath, failed);
      if (failed.workspaceId) {
        await this.runHerdr([
          "workspace",
          "rename",
          failed.workspaceId,
          "[jc] gateway alert · investigator blocked",
        ]).catch(() => undefined);
      }
      await this.emitTelemetry("gateway_alert_investigator.failed", failed, false, message);
      return { ok: false, action: "blocked", incident: failed };
    }
  }

  private async ensureDefaultHerdr(): Promise<void> {
    const alreadyReady = await this.runHerdr(["status"], 5_000)
      .then((result) => result.exitCode === 0)
      .catch(() => false);
    if (alreadyReady) return;

    if (this.insideHerdr) {
      throw new Error("Refusing to restart the default Herdr from one of its own panes");
    }
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (uid === undefined)
      throw new Error("Cannot resolve uid for the default Herdr launch domain");
    const kicked = await this.runCommand({
      command: this.launchctlBin,
      args: ["kickstart", "-k", `gui/${uid}/com.joelclaw.herdr-server`],
      timeoutMs: 10_000,
    });
    if (kicked.exitCode !== 0) {
      throw new Error(`Could not start default Herdr: ${kicked.stderr.trim()}`);
    }

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await this.sleep(500);
      const ready = await this.runHerdr(["status"], 5_000)
        .then((result) => result.exitCode === 0)
        .catch(() => false);
      if (ready) return;
    }
    throw new Error("Default Herdr did not become ready after launchd kickstart");
  }

  private async workspaceExists(workspaceId: string): Promise<boolean> {
    return this.runHerdr(["workspace", "get", workspaceId], 5_000)
      .then((result) => result.exitCode === 0)
      .catch(() => false);
  }

  private async ensureWorkspace(incident: GatewayAlertIncident): Promise<{
    readonly workspaceId: string;
    readonly paneId: string;
    readonly created: boolean;
  }> {
    if (
      incident.workspaceId &&
      incident.paneId &&
      (await this.workspaceExists(incident.workspaceId))
    ) {
      return {
        workspaceId: incident.workspaceId,
        paneId: incident.paneId,
        created: false,
      };
    }

    const discovered = await this.discoverWorkspace(incidentWorkspaceLabel(incident));
    if (discovered) return { ...discovered, created: false };

    const created = await this.runHerdr([
      "workspace",
      "create",
      "--cwd",
      this.repoRoot,
      "--label",
      incidentWorkspaceLabel(incident),
      "--no-focus",
    ]);
    if (created.exitCode !== 0) {
      throw new Error(`Could not create investigator workspace: ${created.stderr.trim()}`);
    }
    const result = parseHerdrResult(created.stdout);
    const workspace = result.workspace as { readonly workspace_id?: string } | undefined;
    const rootPane = result.root_pane as { readonly pane_id?: string } | undefined;
    if (!workspace?.workspace_id || !rootPane?.pane_id) {
      throw new Error("Herdr workspace receipt omitted workspace or root pane id");
    }
    return {
      workspaceId: workspace.workspace_id,
      paneId: rootPane.pane_id,
      created: true,
    };
  }

  private async discoverWorkspace(
    label: string,
  ): Promise<{ readonly workspaceId: string; readonly paneId: string } | undefined> {
    const listed = await this.runHerdr(["workspace", "list"], 5_000);
    if (listed.exitCode !== 0) return undefined;
    const listResult = parseHerdrResult(listed.stdout);
    const workspaces = listResult.workspaces as
      | ReadonlyArray<{ readonly workspace_id?: string; readonly label?: string }>
      | undefined;
    const workspaceId = workspaces?.find((workspace) => workspace.label === label)?.workspace_id;
    if (!workspaceId) return undefined;

    const paneList = await this.runHerdr(["pane", "list", "--workspace", workspaceId], 5_000);
    if (paneList.exitCode !== 0) return undefined;
    const paneResult = parseHerdrResult(paneList.stdout);
    const panes = paneResult.panes as ReadonlyArray<{ readonly pane_id?: string }> | undefined;
    const paneId = panes?.[0]?.pane_id;
    return paneId ? { workspaceId, paneId } : undefined;
  }

  private async agentExists(agentName: string): Promise<boolean> {
    return this.runHerdr(["agent", "get", agentName], 5_000)
      .then((result) => result.exitCode === 0)
      .catch(() => false);
  }

  private async ensureAgent(incident: GatewayAlertIncident): Promise<void> {
    if (!incident.agentName || !incident.paneId) {
      throw new Error("Incident has no agent name or pane id");
    }
    if (await this.agentExists(incident.agentName)) return;
    const started = await this.runHerdr(
      [
        "agent",
        "start",
        incident.agentName,
        "--kind",
        "pi",
        "--pane",
        incident.paneId,
        "--timeout",
        "60000",
        "--",
        "--model",
        this.model,
        "--name",
        "🩺 Gateway Alert Investigator",
      ],
      70_000,
    );
    if (started.exitCode !== 0) {
      throw new Error(`Could not start DGX GLM investigator: ${started.stderr.trim()}`);
    }
  }

  private runHerdr(args: readonly string[], timeoutMs = 30_000): Promise<CommandResult> {
    return this.runCommand({
      command: this.herdrBin,
      args,
      cwd: this.repoRoot,
      env: this.herdrEnv,
      timeoutMs,
    });
  }

  private async emitTelemetry(
    action: string,
    incident: GatewayAlertIncident,
    success: boolean,
    error?: string,
  ): Promise<void> {
    const metadata = JSON.stringify({
      incidentId: incident.incidentId,
      kind: incident.kind,
      phase: incident.phase,
      attempt: incident.attempt,
      workspaceId: incident.workspaceId,
      paneId: incident.paneId,
      model: this.model,
    });
    const args = [
      "otel",
      "emit",
      action,
      "--source",
      "gateway-tripwire",
      "--component",
      "gateway-alert-investigator",
      "--level",
      success ? "info" : "error",
      "--success",
      String(success),
      "--metadata",
      metadata,
    ];
    if (error) args.push("--error", error);
    await this.runCommand({ command: this.joelclawBin, args, timeoutMs: 10_000 }).catch(
      () => undefined,
    );
  }
}

function usage(): never {
  console.error("usage: gateway-alert-investigator <alert missing|stale [age-seconds]|recover>");
  process.exit(2);
}

async function main(args: readonly string[]): Promise<void> {
  const investigator = new GatewayAlertInvestigator();
  let result: GatewayAlertResult;
  if (args[0] === "alert" && (args[1] === "missing" || args[1] === "stale")) {
    const ageSeconds = args[2] === undefined ? undefined : Number.parseInt(args[2], 10);
    if (ageSeconds !== undefined && (!Number.isSafeInteger(ageSeconds) || ageSeconds < 0)) usage();
    result = await investigator.alert(args[1], ageSeconds);
  } else if (args[0] === "recover") {
    result = await investigator.recover();
  } else {
    usage();
  }
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
