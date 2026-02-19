import { inngest } from "../client";
import { NonRetriableError } from "inngest";
import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

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

      try {
        const cmd = buildCommand(tool, task, { model, sandbox, timeout });
        const output = execSync(cmd, {
          cwd: workDir,
          encoding: "utf-8",
          timeout: timeout * 1000,
          maxBuffer: 10 * 1024 * 1024, // 10MB
          env: {
            ...process.env,
            // Ensure non-interactive
            CI: "true",
            TERM: "dumb",
          },
        });

        return {
          status: "completed" as const,
          output: output.trim().slice(-50_000), // last 50k chars
        };
      } catch (error: any) {
        const stderr = error.stderr?.toString().trim() || "";
        const stdout = error.stdout?.toString().trim() || "";
        const message = error.message || String(error);
        const code = error.status ?? error.code ?? "unknown";

        return {
          status: "failed" as const,
          output: stdout.slice(-10_000),
          error: `Exit ${code}: ${stderr.slice(-5_000) || message.slice(-5_000)}`,
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
  }
): string {
  // Escape task for shell — single-quote with escaped single-quotes
  const escaped = task.replace(/'/g, "'\\''");

  switch (tool) {
    case "codex":
      return [
        "codex exec",
        "--full-auto",
        opts.model ? `-m ${opts.model}` : "",
        opts.sandbox ? `-s ${opts.sandbox}` : "",
        `'${escaped}'`,
      ]
        .filter(Boolean)
        .join(" ");

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
        "--no-tools",
        "--no-session",
        "--print",
        "--mode text",
        `--system-prompt '${escaped}'`,
        `'Analyze and respond.'`,
      ]
        .filter(Boolean)
        .join(" ");

    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}
