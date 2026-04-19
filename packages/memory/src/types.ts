export type RunStatus = "active" | "deleted";

export type AgentRuntime =
  | "pi"
  | "claude-code"
  | "codex"
  | "loop"
  | "workload-stage"
  | "gateway"
  | "other";

export type Role = "user" | "assistant" | "tool";

export interface Run {
  id: string;
  user_id: string;
  machine_id: string;
  agent_runtime: AgentRuntime;
  agent_version: string;
  model: string;
  parent_run_id: string | null;
  root_run_id: string | null;
  conversation_id: string | null;
  tags: string[];
  readable_by: string[];
  intent: string;
  started_at: number;
  ended_at: number;
  duration_ms: number;
  turn_count: number;
  user_turn_count: number;
  assistant_turn_count: number;
  tool_turn_count: number;
  token_total: number;
  tool_call_count: number;
  files_touched: string[];
  skills_invoked: string[];
  entities_mentioned: string[];
  enriched_at: number | null;
  enrichment_model: string | null;
  status: RunStatus;
  full_text: string;
  jsonl_path: string;
  jsonl_bytes: number;
  jsonl_sha256: string;
}

export interface Chunk {
  id: string;
  run_id: string;
  chunk_idx: number;
  role: Role;
  text: string;
  embedding: number[];
  embedding_model: string;
  token_count: number;
  started_at: number;
  user_id: string;
  readable_by: string[];
  root_run_id: string | null;
  agent_runtime: AgentRuntime;
  conversation_id: string | null;
  tags: string[];
  machine_id: string;
}

export interface ShareGrant {
  id: string;
  grantor_user_id: string;
  grantee_user_id: string;
  scope: `tag:${string}` | `run:${string}`;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
}
