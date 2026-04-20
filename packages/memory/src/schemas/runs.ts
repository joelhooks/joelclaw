import type { TypesenseCollectionSchema } from "./run-chunks";

export const RUNS_COLLECTION = "runs_dev";

export function runsSchema(
  name: string = RUNS_COLLECTION
): TypesenseCollectionSchema {
  return {
    name,
    fields: [
      { name: "id", type: "string" },
      { name: "user_id", type: "string", facet: true },
      { name: "machine_id", type: "string", facet: true },
      { name: "agent_runtime", type: "string", facet: true },
      { name: "agent_version", type: "string", optional: true },
      { name: "model", type: "string", facet: true, optional: true },
      { name: "parent_run_id", type: "string", facet: true, optional: true },
      { name: "root_run_id", type: "string", facet: true, optional: true },
      { name: "conversation_id", type: "string", facet: true, optional: true },
      { name: "tags", type: "string[]", facet: true, optional: true },
      { name: "readable_by", type: "string[]", facet: true },
      { name: "intent", type: "string", optional: true },
      { name: "started_at", type: "int64", sort: true },
      { name: "ended_at", type: "int64", sort: true, optional: true },
      { name: "duration_ms", type: "int32", optional: true },
      { name: "turn_count", type: "int32" },
      { name: "user_turn_count", type: "int32", optional: true },
      { name: "assistant_turn_count", type: "int32", optional: true },
      { name: "tool_turn_count", type: "int32", optional: true },
      { name: "token_total", type: "int64", optional: true },
      { name: "tool_call_count", type: "int32", optional: true },
      { name: "files_touched", type: "string[]", facet: true, optional: true },
      { name: "skills_invoked", type: "string[]", facet: true, optional: true },
      { name: "entities_mentioned", type: "string[]", facet: true, optional: true },
      { name: "enriched_at", type: "int64", sort: true, optional: true },
      { name: "enrichment_model", type: "string", optional: true },
      { name: "status", type: "string", facet: true },
      { name: "full_text", type: "string", optional: true },
      { name: "jsonl_path", type: "string", optional: true },
      { name: "jsonl_bytes", type: "int32", optional: true },
      { name: "jsonl_sha256", type: "string", optional: true },
    ],
    default_sorting_field: "started_at",
  };
}
