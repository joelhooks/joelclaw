import { existsSync } from "node:fs";
import { MODEL } from "../../lib/models";
import type { SwarmTool } from "../../swarm/schema";
import type { SwarmAgentExecInput, SwarmAgentExecResult } from "../../swarm/types";
import { inngest } from "../client";

const OUTPUT_LIMIT = 20_000;
const SUMMARY_LIMIT = 400;

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function buildPrompt(input: SwarmAgentExecInput): string {
  const sections = [
    `Swarm: ${input.swarmName}`,
    `Wave: ${input.wave}`,
    `Agent: ${input.agent.name}`,
    `Role: ${input.agent.role}`,
    "",
    "Task:",
    input.agent.task,
  ];

  if (input.agent.extraContext) {
    sections.push("", "Extra context:", input.agent.extraContext);
  }

  return sections.join("\n").trim();
}

function resolveTool(input: SwarmAgentExecInput): SwarmTool {
  return input.agent.tool ?? input.tool ?? "codex";
}

async function runAgentTool(input: SwarmAgentExecInput): Promise<{
  exitCode: number;
  output: string;
}> {
  const tool = resolveTool(input);
  const prompt = buildPrompt(input);
  const model = input.agent.model ?? input.model ?? MODEL.CODEX;

  let cmd: string[];
  switch (tool) {
    case "codex":
      cmd = [
        "codex",
        "exec",
        "--full-auto",
        "-m",
        model,
        "--sandbox",
        input.agent.sandbox,
        prompt,
      ];
      break;
    case "claude":
      cmd = [
        "claude",
        "-p",
        prompt,
        "--output-format",
        "text",
        "--dangerously-skip-permissions",
      ];
      break;
    case "pi":
      cmd = ["pi", "--prompt", prompt, "--no-tui"];
      break;
    default:
      cmd = ["codex", "exec", "--full-auto", "-m", model, prompt];
      break;
  }

  const proc = Bun.spawn(cmd, {
    cwd: input.workspace,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: process.env.HOME },
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const combined = `${stdout}${stderr ? `\n\n--- STDERR ---\n${stderr}` : ""}`.trim();
  return {
    exitCode,
    output: combined.slice(0, OUTPUT_LIMIT),
  };
}

export const swarmAgentExec = inngest.createFunction(
  {
    id: "swarm-agent-exec",
    retries: 2,
  },
  { event: "swarm/agent.started" },
  async ({ event, step }) => {
    const payload = event.data as Partial<SwarmAgentExecInput>;

    if (!payload?.agent || !payload.workspace || !payload.swarmName || payload.wave === undefined) {
      return {
        swarmName: payload?.swarmName ?? "unknown",
        agentName: payload?.agent?.name ?? "unknown",
        wave: typeof payload?.wave === "number" ? payload.wave : -1,
        success: false,
        summary: "Invalid invoke payload",
        error:
          "swarm-agent-exec expected { swarmName, workspace, wave, agent } from step.invoke",
      } satisfies SwarmAgentExecResult;
    }

    if (!existsSync(payload.workspace)) {
      return {
        swarmName: payload.swarmName,
        agentName: payload.agent.name,
        wave: payload.wave,
        success: false,
        summary: "Workspace not found",
        error: `Workspace does not exist: ${payload.workspace}`,
      } satisfies SwarmAgentExecResult;
    }

    const input: SwarmAgentExecInput = {
      swarmName: payload.swarmName,
      workspace: payload.workspace,
      wave: payload.wave,
      agent: payload.agent,
      model: payload.model,
      tool: payload.tool,
    };

    try {
      const result = await step.run("exec-agent", async () => runAgentTool(input));
      const success = result.exitCode === 0;
      const summarySource = result.output || `exit code ${result.exitCode}`;

      return {
        swarmName: input.swarmName,
        agentName: input.agent.name,
        wave: input.wave,
        success,
        summary: summarySource.slice(0, SUMMARY_LIMIT),
        output: result.output,
        ...(success ? {} : { error: `Tool exited with code ${result.exitCode}` }),
      } satisfies SwarmAgentExecResult;
    } catch (error) {
      const message = stringifyError(error);
      return {
        swarmName: input.swarmName,
        agentName: input.agent.name,
        wave: input.wave,
        success: false,
        summary: message.slice(0, SUMMARY_LIMIT),
        error: message,
      } satisfies SwarmAgentExecResult;
    }
  },
);
