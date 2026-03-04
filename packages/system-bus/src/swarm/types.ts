import type { SwarmAgent, SwarmTool } from "./schema";

export interface SwarmStartedEventData {
  yaml: string;
  name: string;
  workspace: string;
}

export interface SwarmAgentStartedEventData {
  swarmName: string;
  agentName: string;
  wave: number;
}

export interface SwarmAgentCompletedEventData {
  swarmName: string;
  agentName: string;
  wave: number;
  success: boolean;
  error?: string;
}

export interface SwarmCompletedEventData {
  name: string;
  status: "completed" | "failed";
  errors: string[];
}

export interface SwarmAgentExecInput {
  swarmName: string;
  workspace: string;
  wave: number;
  agent: SwarmAgent;
  model?: string;
  tool?: SwarmTool;
}

export interface SwarmAgentExecResult {
  swarmName: string;
  agentName: string;
  wave: number;
  success: boolean;
  summary: string;
  output?: string;
  error?: string;
}
