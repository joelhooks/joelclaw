import type { TypesenseCollectionSchema } from "./run-chunks";

export const MACHINES_COLLECTION = "machines_dev";

export function machinesSchema(
  name: string = MACHINES_COLLECTION
): TypesenseCollectionSchema {
  return {
    name,
    fields: [
      { name: "id", type: "string" },
      { name: "user_id", type: "string", facet: true },
      { name: "did", type: "string", facet: true },
      { name: "handle", type: "string", facet: true },
      { name: "machine_name", type: "string", facet: true },
      { name: "app_password_name", type: "string" },
      { name: "app_password_sha256", type: "string", facet: true },
      { name: "created_at", type: "int64", sort: true },
      { name: "last_seen_at", type: "int64", sort: true, optional: true },
      { name: "revoked_at", type: "int64", sort: true, optional: true },
    ],
    default_sorting_field: "created_at",
  };
}
