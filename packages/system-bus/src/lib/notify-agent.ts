import { NonRetriableError } from "inngest";
import { emitOtelEvent } from "../observability/emit";
import { redactJoelMessage } from "./notify-joel";

export type NotifyAgentInput = {
  to: string;
  cc?: string[];
  summary: string;
  message: string;
  source: string;
  quiet?: boolean;
};

type FailureCode =
  | "missing_name"
  | "invalid_recipient"
  | "spawn_failed"
  | "refused"
  | "lease_held"
  | "exit_failed";

export class NotifyAgentError extends Error {
  override readonly name = "NotifyAgentError";
  constructor(
    readonly code: FailureCode,
    readonly exitCode?: number,
  ) {
    super(`Agent notification failed (${code})`);
  }
}

/** Delivery may already have happened. Inngest must not automatically resend. */
export class NotifyAgentUncertainError extends NonRetriableError {
  constructor(
    readonly code: "uncertain" | "timeout",
    readonly exitCode?: number,
  ) {
    super(`Agent notification delivery uncertain (${code}); inspect receipt before resending`);
  }
}

type AgentProcess = { exited: Promise<number>; kill: () => void };
export type NotifyAgentDependencies = {
  spawn: (
    argv: string[],
    options: { stdin: Uint8Array; stdout: "ignore"; stderr: "ignore" },
  ) => AgentProcess;
  env: Record<string, string | undefined>;
  emit: (event: Parameters<typeof emitOtelEvent>[0]) => Promise<unknown>;
  setTimer: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
};

const defaults: NotifyAgentDependencies = {
  spawn: (argv, options) => {
    const child = Bun.spawn(argv, options);
    return { exited: child.exited, kill: () => child.kill("SIGKILL") };
  },
  env: process.env,
  emit: emitOtelEvent,
  setTimer: setTimeout,
  clearTimer: clearTimeout,
};

export function isRatKingName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]*(\/[a-z0-9-]+)?$/.test(value);
}

export async function notifyAgent(
  input: NotifyAgentInput,
  dependencies: NotifyAgentDependencies = defaults,
): Promise<void> {
  // Lifecycle: validate -> running -> sent | refused | lease-held | uncertain.
  // Timeout also means uncertain: killing a sender does not undo an accepted send.
  let failure: NotifyAgentError | NotifyAgentUncertainError | undefined;
  try {
    const sender = dependencies.env.JOELCLAW_RATKING_NAME?.trim();
    if (!sender || !isRatKingName(sender)) throw new NotifyAgentError("missing_name");
    if (!isRatKingName(input.to)) throw new NotifyAgentError("invalid_recipient");
    const cc = input.cc ?? [];
    if (!cc.every(isRatKingName)) throw new NotifyAgentError("invalid_recipient");
    const argv = [
      dependencies.env.RATKING_BIN?.trim() || "ratking",
      "send",
      "--as",
      sender,
      "--to",
      input.to,
      ...cc.flatMap((name) => ["--cc", name]),
      ...(input.quiet ? ["--quiet"] : []),
      "--summary",
      redactJoelMessage(input.summary).replace(/\s+/gu, " ").trim().slice(0, 280),
      "--body",
      "-",
      "--json",
    ];
    const process = dependencies.spawn(argv, {
      stdin: new TextEncoder().encode(redactJoelMessage(input.message)),
      stdout: "ignore",
      stderr: "ignore",
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let exit: number;
    try {
      exit = await Promise.race([
        process.exited,
        new Promise<never>((_resolve, reject) => {
          timer = dependencies.setTimer(() => {
            try {
              process.kill();
            } catch {
              /* Do not expose subprocess errors. */
            }
            reject(new NotifyAgentUncertainError("timeout"));
          }, 15_000);
        }),
      ]);
    } finally {
      if (timer !== undefined) dependencies.clearTimer(timer);
    }
    if (exit === 3) throw new NotifyAgentUncertainError("uncertain", exit);
    if (exit !== 0) {
      throw new NotifyAgentError(
        exit === 2 ? "refused" : exit === 4 ? "lease_held" : "exit_failed",
        exit,
      );
    }
  } catch (error) {
    failure =
      error instanceof NotifyAgentError || error instanceof NotifyAgentUncertainError
        ? error
        : new NotifyAgentError("spawn_failed");
  }

  // Never include message or CLI output.
  // Telemetry failure must not turn a successful send into an automatic duplicate.
  await dependencies
    .emit({
      level: failure ? "warn" : "info",
      source: "worker",
      component: "notify-agent",
      action: failure ? "agent.notify.failed" : "agent.notify.sent",
      success: !failure,
      metadata: {
        source: input.source,
        to: input.to,
        quiet: input.quiet ?? false,
        ...(failure ? { code: failure.code, exitCode: failure.exitCode } : {}),
      },
    })
    .catch(() => undefined);
  if (failure) throw failure;
}
