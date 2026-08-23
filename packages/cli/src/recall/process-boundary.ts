/**
 * The flowing recall process boundary.
 *
 * Two rules hold for every child spawned here:
 *
 * 1. The parent environment is never inherited. Each child receives an explicit
 *    allow-listed environment and nothing else, so an unrelated token in the
 *    parent process cannot reach a subprocess.
 * 2. The deadline is hard. On expiry the child's process group gets SIGTERM,
 *    then SIGKILL after a bounded grace period, and the runner awaits the exit
 *    so the process is reaped. A SIGTERM-resistant child cannot wedge the caller.
 *
 * Neither the query nor the leased credential is ever placed in argv.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export interface BoundaryProcessRequest {
  /** Executable and flags only. Never query text, never secrets. */
  readonly command: readonly string[];
  /** The complete private payload. */
  readonly stdin: string;
  /** The exact child environment. The parent environment is not inherited. */
  readonly env: Record<string, string>;
  readonly timeoutMs: number;
}

export interface BoundaryProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly missingExecutable: boolean;
}

export type BoundaryProcessRunner = (
  request: BoundaryProcessRequest,
) => Promise<BoundaryProcessResult>;

export type CredentialLeaseOutcome =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly message: string };

export interface CredentialLeaseRequest {
  /** The secret name only. The executable and its flags are adapter-owned. */
  readonly secretName: string;
  /** `raw` is the installed default: the value on stdout with no envelope. */
  readonly format: CredentialLeaseFormat;
  readonly timeoutMs: number;
  /** Test seam. Production resolves the trusted installed path. */
  readonly executable?: string;
}

export type CredentialLeaseFormat = "raw" | "json";

export type CredentialLeaseRunner = (
  request: CredentialLeaseRequest,
) => Promise<CredentialLeaseOutcome>;

/** Grace between SIGTERM and SIGKILL. Bounded so a hung child cannot extend it. */
export const KILL_GRACE_MS = 250;
/** Absolute backstop after SIGKILL. SIGKILL is uncatchable; this only bounds reaping. */
export const REAP_BACKSTOP_MS = 2_000;

/** The installed agent-secrets CLI. Not configurable from project config. */
export const AGENT_SECRETS_EXECUTABLE = join(homedir(), ".local", "bin", "secrets");

/**
 * Fixed lease shape. The default TTL is an hour; a recall comparison needs the
 * credential for one child process, so it asks for the shortest useful window
 * and names itself in the audit trail instead of inheriting the hostname.
 * Neither flag changes the raw stdout contract.
 */
export const AGENT_SECRETS_LEASE_TTL = "5m";
export const AGENT_SECRETS_CLIENT_ID = "joelclaw-recall-compare";

/** Replaces a leased secret wherever it could leak into text we surface. */
export function redactSecret(text: string, secret: string | undefined): string {
  if (!secret || secret.length < 4) return text;
  return text.split(secret).join("[redacted]");
}

/**
 * A minimal child environment.
 *
 * The parent environment may hold unrelated credentials, tokens, and machine
 * topology. A child here needs a search path, a home directory, and at most one
 * injected value — nothing else. Callers pass the parent explicitly so a test
 * can prove the filter rather than trust it.
 */
export function minimalChildEnv(
  parent: Record<string, string | undefined>,
  extra: Record<string, string> = {},
): Record<string, string> {
  const allowed = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"];
  const env: Record<string, string> = { TERM: "dumb" };
  for (const key of allowed) {
    const value = parent[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  return { ...env, ...extra };
}

function isMissingExecutable(message: string): boolean {
  return /executable not found|ENOENT|no such file/iu.test(message);
}

/** `Bun.spawn` types its pipes loosely; only a real stream has output to read. */
function readStream(stream: unknown): Promise<string> {
  if (!(stream instanceof ReadableStream)) return Promise.resolve("");
  return new Response(stream as ReadableStream<Uint8Array>).text().catch(() => "");
}

/** Kills the child's own process group, which `detached` makes it lead. */
function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone. Nothing to reap.
    }
  }
}

/**
 * Production process runner.
 *
 * Writes the whole payload to stdin, closes it, and enforces a hard deadline
 * with SIGTERM, then SIGKILL, against the child's process group. `detached`
 * puts the child in its own group so descendants die with it and this process's
 * own group is never signalled.
 */
export const bunProcessRunner: BoundaryProcessRunner = async (request) => {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([...request.command], {
      stdin: new TextEncoder().encode(request.stdin),
      stdout: "pipe",
      stderr: "pipe",
      env: request.env,
      detached: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exitCode: 127,
      stdout: "",
      stderr: message,
      timedOut: false,
      missingExecutable: isMissingExecutable(message),
    };
  }

  const stdoutPromise = readStream(child.stdout);
  const stderrPromise = readStream(child.stderr);

  let timedOut = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = setTimeout(() => {
    timedOut = true;
    killGroup(child.pid, "SIGTERM");
    graceTimer = setTimeout(() => killGroup(child.pid, "SIGKILL"), KILL_GRACE_MS);
  }, request.timeoutMs);

  let backstopTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    // SIGKILL is uncatchable, so `exited` resolves. The backstop only bounds the
    // wait if the platform is doing something stranger than a wedged child.
    const exitCode = await Promise.race([
      child.exited,
      new Promise<number>((resolve) => {
        backstopTimer = setTimeout(
          () => resolve(137),
          request.timeoutMs + KILL_GRACE_MS + REAP_BACKSTOP_MS,
        );
      }),
    ]);

    const [stdout, stderr] = await Promise.all([
      Promise.race([stdoutPromise, new Promise<string>((r) => setTimeout(() => r(""), 250))]),
      Promise.race([stderrPromise, new Promise<string>((r) => setTimeout(() => r(""), 250))]),
    ]);

    return {
      exitCode: timedOut ? 124 : exitCode,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      timedOut,
      missingExecutable: false,
    };
  } finally {
    clearTimeout(deadline);
    if (graceTimer) clearTimeout(graceTimer);
    if (backstopTimer) clearTimeout(backstopTimer);
  }
};

/** The installed CLI accepts a bounded secret name, never a path or a flag. */
const SECRET_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/u;

export function isValidSecretName(value: string): boolean {
  return SECRET_NAME_PATTERN.test(value);
}

/**
 * Reads the value out of the installed agent-secrets `--json` envelope.
 *
 * The installed CLI at commit 57c96823 puts the value at `result.value` and
 * nowhere else. Guessing at `value`, `secret`, or `data.value` is what let a
 * whole JSON document become a database URL, so this reads exactly one path.
 */
export function extractJsonLeaseValue(parsed: unknown): string | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const result = (parsed as { result?: unknown }).result;
  if (typeof result !== "object" || result === null) return undefined;
  const value = (result as { value?: unknown }).value;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export interface AgentSecretsLeaseInput extends CredentialLeaseRequest {
  readonly runProcess?: BoundaryProcessRunner;
  readonly parentEnv?: Record<string, string | undefined>;
}

/**
 * Production credential lease against the installed agent-secrets CLI.
 *
 * The argv is owned here — `secrets lease <name> --ttl 5m --client-id
 * joelclaw-recall-compare` for the raw contract, plus `--json` only when JSON
 * output was deliberately configured. Project config
 * supplies the secret name and nothing else, so it cannot point the lease at
 * arbitrary code. The child runs under the same minimal environment as the read
 * command, and no backend stdout or stderr enters the failure message, because
 * a lease backend routinely prints the value it failed to protect.
 */
export async function leaseAgentSecret(
  input: AgentSecretsLeaseInput,
): Promise<CredentialLeaseOutcome> {
  if (!isValidSecretName(input.secretName)) {
    return { ok: false, message: "credential secret name is not a valid agent-secrets name" };
  }

  const executable = input.executable ?? AGENT_SECRETS_EXECUTABLE;
  const command = [
    executable,
    "lease",
    input.secretName,
    "--ttl",
    AGENT_SECRETS_LEASE_TTL,
    "--client-id",
    AGENT_SECRETS_CLIENT_ID,
    ...(input.format === "json" ? ["--json"] : []),
  ];

  const runProcess = input.runProcess ?? bunProcessRunner;
  let proc: BoundaryProcessResult;
  try {
    proc = await runProcess({
      command,
      stdin: "",
      env: minimalChildEnv(input.parentEnv ?? process.env),
      timeoutMs: input.timeoutMs,
    });
  } catch {
    return { ok: false, message: "credential lease failed to start" };
  }

  if (proc.missingExecutable) {
    return { ok: false, message: "credential lease executable is not available" };
  }
  if (proc.timedOut) {
    return { ok: false, message: "credential lease exceeded its deadline" };
  }
  if (proc.exitCode !== 0) {
    return { ok: false, message: `credential lease exited ${proc.exitCode}` };
  }

  if (input.format === "json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(proc.stdout);
    } catch {
      return { ok: false, message: "credential lease did not return one JSON document" };
    }
    const value = extractJsonLeaseValue(parsed);
    if (!value) {
      return { ok: false, message: "credential lease JSON envelope carried no result.value" };
    }
    return { ok: true, value };
  }

  const value = proc.stdout.trim();
  if (!value) {
    return { ok: false, message: "credential lease returned an empty value" };
  }
  return { ok: true, value };
}

export const agentSecretsCredentialLease: CredentialLeaseRunner = (request) =>
  leaseAgentSecret(request);
