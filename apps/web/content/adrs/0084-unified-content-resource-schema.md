---
status: deferred
date: 2026-02-21
decision-makers: Joel
---

# ADR-0084: Unified Content Resource Schema (Convex)

## Context

joelclaw.com's Convex backend has 5 separate tables for different content types: `vaultNotes`, `memoryObservations`, `systemLog`, `notifications`, `systemStatus`. Each has its own schema, queries, mutations, and worker push helpers. Adding a new content type requires: new table in schema.ts, new query file, new mutation file, new worker helper, new page wiring.

Joel's CourseBuilder project (`badass-courses/course-builder`) uses a polymorphic `ContentResource` pattern that eliminates this per-type overhead. One table, `type` discriminator, `fields` JSON bag for type-specific data.

Credit: This pattern is from Joel's CourseBuilder project ([content-resource.ts](https://github.com/badass-courses/course-builder/blob/main/packages/adapter-drizzle/src/lib/mysql/schemas/content/content-resource.ts)).

## Decision

Migrate all Convex content tables to a single `contentResources` table:

```ts
contentResources: defineTable({
  resourceId: v.string(),    // deterministic ID, e.g. "vault:Projects/09-joelclaw/index.md"
  type: v.string(),           // "vault_note", "memory_observation", "system_log", "notification", "system_status"
  fields: v.any(),            // type-specific payload
  createdAt: v.number(),
  updatedAt: v.number(),
  deletedAt: v.optional(v.number()),
})
  .index("by_resourceId", ["resourceId"])
  .index("by_type", ["type"])
  .index("by_type_updatedAt", ["type", "updatedAt"])
  .searchIndex("search_fields", { searchField: "type", filterFields: ["type"] })
```

Plus a `contentResourceResource` join table for parent/child relationships:

```ts
contentResourceResource: defineTable({
  parentId: v.string(),       // resourceId of parent
  childId: v.string(),        // resourceId of child
  position: v.optional(v.number()),
  metadata: v.optional(v.any()),
})
  .index("by_parentId", ["parentId"])
  .index("by_childId", ["childId"])
```

### Type-specific field shapes

- **vault_note**: `{ path, title, content, html, tags, section }`
- **memory_observation**: `{ observation, category, source, sessionId, superseded }`
- **system_log**: `{ action, tool, detail, reason }`
- **notification**: `{ title, body, notificationType, metadata, read }`
- **system_status**: `{ component, status, detail, checkedAt }`

### ID scheme

- `vault:{path}` — vault notes
- `obs:{uuid}` — memory observations
- `slog:{index}` — system log entries
- `notif:{uuid}` — notifications
- `status:{component}` — system status

## Consequences

- **Adding new content types = zero schema changes** — just a new `type` string
- **One set of CRUD queries** — `getByResourceId`, `listByType`, `upsert`, `search`
- **Hierarchies via join table** — vault sections → notes, future: blog → related
- **Tradeoff**: Convex search index can't deeply index into `fields` — Typesense handles search
- **Migration**: backfill existing 5 tables → contentResources, update pages + worker helpers, then drop old tables

## Tables to migrate

| Old Table | Docs | New Type | ID Pattern |
|-----------|------|----------|------------|
| vaultNotes | 1,509 | vault_note | vault:{path} |
| memoryObservations | 1,452 | memory_observation | obs:{observationId} |
| systemLog | ~577 | system_log | slog:{entryId} |
| notifications | ~50 | notification | notif:{_id} |
| systemStatus | ~6 | system_status | status:{component} |
