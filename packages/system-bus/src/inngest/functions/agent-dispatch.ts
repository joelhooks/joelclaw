import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NonRetriableError } from "inngest";
import { infer } from "../../lib/inference";
import { inngest } from "../client";

const INBOX_DIR = join(
  process.env.HOME || "/Users/joel",
  ".joelclaw",
  "workspace",
  "inbox"
);

type InboxResult = {
  requestId: string;
  sessionId?: string;
  status: "completed" | "failed";
  task: string;
  tool: string;
  result?: string;
  error?: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
};

const PI_FILE_HINT_PATTERN =
  /(?:\/Users\/|~\/|(?:^|[\s"'`])[^\s"'`]+\.(?:ts|md)(?=$|[\s"'`]))/i;
const FILE_PATH_PATTERN =
  /(?:^|[\s"'`])(?:~\/|\/|\.\.?\/|[A-Za-z0-9._-]+\/)[^\s"'`]+/;
const FILE_CONTEXT_PATTERN =
  /\b(file|files|path|paths|repo|repository|directory|folder|codebase|source|src)\b/;
const FILE_READ_OPERATION_PATTERN =
  /\b(read|open|inspect|review|scan|grep|search|find|cat|ls|sed|rg)\b/;
const PI_FILE_ANALYSIS_PATH_PATTERN = /\/[A-Za-z0-9_.~-]+\.[a-z]{1,5}(?=$|[\s"'`])/;
const PI_FILE_ANALYSIS_PREFIX_PATTERN = /^\s*(read|analyze|review)\b/i;
const CODEX_DEFAULT_MODEL = "gpt-5.4";
const CODEX_ALLOWED_MODELS = new Set([
  "gpt-5.4",
]);

function taskRequiresFileAccess(task: string): boolean {
  const normalizedTask = task.toLowerCase();

  return (
    PI_FILE_HINT_PATTERN.test(task) ||
    FILE_PATH_PATTERN.test(task) ||
    (FILE_CONTEXT_PATTERN.test(normalizedTask) &&
      FILE_READ_OPERATION_PATTERN.test(normalizedTask))
  );
}

function taskIsIncompatibleWithPiNoTools(task: string): boolean {
  return (
    PI_FILE_ANALYSIS_PATH_PATTERN.test(task) ||
    PI_FILE_ANALYSIS_PREFIX_PATTERN.test(task)
  );
}

function resolveCodexModel(model?: string): string {
  const requestedModel = model?.trim();
  if (!requestedModel) {
    return CODEX_DEFAULT_MODEL;
  }

  if (CODEX_ALLOWED_MODELS.has(requestedModel)) {
    return requestedModel;
  }

  console.warn(
    `[agent-dispatch] Unsupported codex model "${requestedModel}" requested; ` +
      `overriding to "${CODEX_DEFAULT_MODEL}" for ChatGPT account compatibility.`
  );
  return CODEX_DEFAULT_MODEL;
}

async function runAgentCommand(
  command: string,
  options: {
    cwd: string;
    timeoutSeconds: number;
    env: Record<string, string | undefined>;
  }
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bash", "-lc", `exec ${command}`], {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: Object.fromEntries(
      Object.entries(options.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    ),
  });

  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // ignore
    }
  }, Math.max(1, options.timeoutSeconds) * 1000);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);

  return {
    exitCode,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}

/**
 * ADR-0026: Background agent dispatch via Inngest.
 *
 * Spawns codex, claude, or pi to execute a task. Writes result to
 * inbox file for pickup by pi-tools extension. Emits completion event
 * for chaining.
 *
 * Durable (survives restarts), observable (Inngest trace), cross-session
 * (results land in inbox regardless of which session is active).
 */
export const agentDispatch = inngest.createFunction(
  {
    id: "system/agent-dispatch",
    name: "Background Agent Dispatch",
    retries: 1,
    cancelOn: [{ event: "system/agent.cancelled", match: "data.requestId" }],
    throttle: { limit: 3, period: "60s" },
  },
  { event: "system/agent.requested" },
  async ({ event, step }) => {
    const {
      requestId,
      sessionId,
      task,
      tool,
      cwd,
      timeout = 600,
      model,
      sandbox,
      readFiles = false,
    } = event.data;

    if (!requestId || !task || !tool) {
      throw new NonRetriableError(
        "Missing required fields: requestId, task, tool"
      );
    }

    if (!["codex", "claude", "pi"].includes(tool)) {
      throw new NonRetriableError(
        `Unknown tool: ${tool}. Must be codex, claude, or pi.`
      );
    }

    const startedAt = new Date().toISOString();

    // Execute the agent
    const execution = await step.run("execute-agent", async () => {
      const workDir = cwd || process.env.HOME || "/Users/joel";

      // Lease fresh Claude token at runtime (not stale boot-time env var)
      if (tool === "claude") {
        try {
          const lease = execSync("secrets lease claude_oauth_token --ttl 1h", {
            encoding: "utf-8",
            timeout: 5000,
          }).trim();
          if (lease) process.env.CLAUDE_CODE_OAUTH_TOKEN = lease;
        } catch {
          // Fall through to existing env var
        }
      }

      const piNeedsTools = tool === "pi" && (
        readFiles ||
        taskRequiresFileAccess(task) ||
        taskIsIncompatibleWithPiNoTools(task)
      );
      const sharedEnv = {
        ...process.env,
        CI: "true",
        TERM: "dumb",
      };

      try {
        if (tool === "pi") {
          const result = await infer(task, {
            task: "complex",
            model,
            system: "Analyze and respond.",
            component: "agent-dispatch",
            action: "agent-dispatch.pi",
            print: true,
            noTools: !piNeedsTools,
            timeout: timeout * 1000,
            json: false,
            env: sharedEnv,
            cwd: workDir,
          });

          const textOutput = result.text.trim();
          return {
            status: "completed" as const,
            output: textOutput.slice(-50_000),
          };
        }

        const cmd = buildCommand(tool, task, {
          model,
          sandbox,
          timeout,
          allowPiTools: piNeedsTools,
        });
        const commandResult = await runAgentCommand(cmd, {
          cwd: workDir,
          timeoutSeconds: timeout,
          env: sharedEnv,
        });

        if (commandResult.exitCode !== 0) {
          return {
            status: "failed" as const,
            output: commandResult.stdout.slice(-10_000),
            error: `Exit ${commandResult.exitCode}: ${commandResult.stderr.slice(-5_000) || commandResult.stdout.slice(-5_000) || "command failed"}`,
          };
        }

        return {
          status: "completed" as const,
          output: commandResult.stdout.slice(-50_000),
        };
      } catch (error: any) {
        const message = error instanceof Error ? error.message : String(error);

        return {
          status: "failed" as const,
          output: "",
          error: `agent dispatch crashed: ${message.slice(-5_000)}`,
        };
      }
    });

    // Write to inbox
    const inboxResult = await step.run("write-inbox", async () => {
      const completedAt = new Date().toISOString();
      const durationMs =
        new Date(completedAt).getTime() - new Date(startedAt).getTime();

      const result: InboxResult = {
        requestId,
        sessionId,
        status: execution.status,
        task,
        tool,
        ...(execution.status === "completed"
          ? { result: execution.output }
          : { error: execution.error }),
        startedAt,
        completedAt,
        durationMs,
      };

      mkdirSync(INBOX_DIR, { recursive: true });
      const filePath = join(INBOX_DIR, `${requestId}.json`);
      writeFileSync(filePath, JSON.stringify(result, null, 2));

      return { filePath, status: result.status, durationMs };
    });

    // Emit completion event for chaining
    await step.sendEvent("notify-completion", {
      name: "system/agent.completed",
      data: {
        requestId,
        sessionId,
        status: inboxResult.status,
        task,
        tool,
        durationMs: inboxResult.durationMs,
      },
    });

    return {
      requestId,
      status: inboxResult.status,
      inboxFile: inboxResult.filePath,
      durationMs: inboxResult.durationMs,
    };
  }
);

/**
 * Build the CLI command for each tool.
 */
function buildCommand(
  tool: string,
  task: string,
  opts: {
    model?: string;
    sandbox?: string;
    timeout?: number;
    allowPiTools?: boolean;
  }
): string {
  // Escape task for shell — single-quote with escaped single-quotes
  const escaped = task.replace(/'/g, "'\\''");

  switch (tool) {
    case "codex": {
      const codexModel = resolveCodexModel(opts.model);
      return [
        "codex exec",
        "--full-auto",
        `-m ${codexModel}`,
        opts.sandbox ? `-s ${opts.sandbox}` : "",
        `'${escaped}'`,
      ]
        .filter(Boolean)
        .join(" ");
    }

    case "claude":
      return [
        "claude",
        "-p",
        `'${escaped}'`,
        "--dangerously-skip-permissions",
        opts.model ? `--model ${opts.model}` : "",
      ]
        .filter(Boolean)
        .join(" ");

    case "pi":
      return [
        "pi",
        ...(opts.allowPiTools ? [] : ["--no-tools"]),
        "--no-session",
        "--print",
        "--mode json",
        opts.model ? `--model ${opts.model}` : "",
        `--system-prompt '${escaped}'`,
        `'Analyze and respond.'`,
      ]
        .filter(Boolean)
        .join(" ");

    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}
