import { buildDependencyGraph, buildExecutionWaves, detectCycles } from "../../swarm/dag";
import type { SwarmAgent, SwarmTool } from "../../swarm/schema";
import { parseSwarmYaml, validateSwarmDefinition } from "../../swarm/schema";
import type {
  SwarmAgentExecInput,
  SwarmAgentExecResult,
  SwarmCompletedEventData,
} from "../../swarm/types";
import { inngest } from "../client";
import { swarmAgentExec } from "./swarm-agent-exec";

type ParsedSwarm = {
  name: string;
  workspace: string;
  model?: string;
  tool: SwarmTool;
  waves: string[][];
  agents: Record<string, SwarmAgent>;
};

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

export const swarmOrchestrator = inngest.createFunction(
  {
    id: "swarm-orchestrator",
    retries: 3,
  },
  { event: "swarm/started" },
  async ({ event, step }) => {
    const errors: string[] = [];

    let parsed: ParsedSwarm;
    try {
      parsed = await step.run("parse", async () => {
        const definition = parseSwarmYaml(event.data.yaml);
        const validationErrors = validateSwarmDefinition(definition);
        if (validationErrors.length > 0) {
          throw new Error(`Invalid swarm definition: ${validationErrors.join("; ")}`);
        }

        const graph = buildDependencyGraph(definition);
        const cycles = detectCycles(graph);
        if (cycles) {
          throw new Error(`Cycle detected in swarm dependencies: ${cycles.join(", ")}`);
        }

        const waves = buildExecutionWaves(graph);
        return {
          name: event.data.name || definition.name,
          workspace: event.data.workspace || definition.workspace,
          model: definition.model,
          tool: definition.tool,
          waves,
          agents: Object.fromEntries(definition.agents.entries()),
        } satisfies ParsedSwarm;
      });
    } catch (error) {
      const message = stringifyError(error);
      const completion: SwarmCompletedEventData = {
        name: event.data.name,
        status: "failed",
        errors: [message],
      };

      await step.sendEvent("emit-swarm-completed-parse-failure", {
        name: "swarm/completed",
        data: completion,
      });

      return completion;
    }

    for (let waveIndex = 0; waveIndex < parsed.waves.length; waveIndex++) {
      const wave = parsed.waves[waveIndex];
      if (!wave) {
        continue;
      }

      const waveResults = await Promise.all(
        wave.map(async (agentName) => {
          const agent = parsed.agents[agentName];
          if (!agent) {
            return {
              swarmName: parsed.name,
              agentName,
              wave: waveIndex,
              success: false,
              summary: `Agent '${agentName}' missing from parsed swarm definition`,
              error: `Agent '${agentName}' missing from parsed swarm definition`,
            } satisfies SwarmAgentExecResult;
          }

          const invokeData: SwarmAgentExecInput = {
            swarmName: parsed.name,
            workspace: parsed.workspace,
            wave: waveIndex,
            model: parsed.model,
            tool: parsed.tool,
            agent,
          };

          try {
            const result = await step.invoke(`wave-${waveIndex}-agent-${agentName}`, {
              function: swarmAgentExec,
              data: invokeData as any,
            });
            return result as SwarmAgentExecResult;
          } catch (error) {
            const message = stringifyError(error);
            return {
              swarmName: parsed.name,
              agentName,
              wave: waveIndex,
              success: false,
              summary: message,
              error: message,
            } satisfies SwarmAgentExecResult;
          }
        }),
      );

      const failedAgents = waveResults.filter((result) => !result.success);
      if (failedAgents.length > 0) {
        errors.push(
          ...failedAgents.map(
            (result) =>
              `${result.agentName} (wave ${result.wave}): ${result.error ?? result.summary}`,
          ),
        );
        break;
      }
    }

    const completion: SwarmCompletedEventData = {
      name: parsed.name,
      status: errors.length > 0 ? "failed" : "completed",
      errors,
    };

    await step.sendEvent("emit-swarm-completed", {
      name: "swarm/completed",
      data: completion,
    });

    return completion;
  },
);
