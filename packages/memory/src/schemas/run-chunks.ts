export interface TypesenseCollectionSchema {
  name: string;
  fields: Array<{
    name: string;
    type: string;
    facet?: boolean;
    optional?: boolean;
    sort?: boolean;
    index?: boolean;
    num_dim?: number;
    embed?: unknown;
  }>;
  default_sorting_field?: string;
}

export const RUN_CHUNKS_COLLECTION = "run_chunks_dev";

export function runChunksSchema(
  name: string = RUN_CHUNKS_COLLECTION,
  embeddingDimensions: number = 768
): TypesenseCollectionSchema {
  return {
    name,
    fields: [
      { name: "id", type: "string" },
      { name: "run_id", type: "string", facet: true },
      { name: "chunk_idx", type: "int32" },
      { name: "role", type: "string", facet: true },
      { name: "text", type: "string" },
      { name: "embedding", type: "float[]", num_dim: embeddingDimensions },
      { name: "embedding_model", type: "string", facet: true },
      { name: "token_count", type: "int32" },
      { name: "started_at", type: "int64", sort: true },
      { name: "user_id", type: "string", facet: true },
      { name: "readable_by", type: "string[]", facet: true },
      { name: "root_run_id", type: "string", facet: true, optional: true },
      { name: "agent_runtime", type: "string", facet: true },
      { name: "conversation_id", type: "string", facet: true, optional: true },
      { name: "tags", type: "string[]", facet: true, optional: true },
      { name: "machine_id", type: "string", facet: true },
    ],
    default_sorting_field: "started_at",
  };
}
