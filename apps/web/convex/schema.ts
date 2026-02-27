/**
 * Convex schema for joelclaw.com — ADR-0075
 *
 * Stores live operational data (not content — that stays in Typesense/Vault).
 * Better Auth tables: users, sessions, accounts, verifications.
 * Dashboard tables: systemStatus, notifications.
 */
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // ── Better Auth tables ────────────────────────────────────────────
  // These follow Better Auth's expected schema for the Convex adapter

  users: defineTable({
    name: v.string(),
    email: v.string(),
    emailVerified: v.boolean(),
    image: v.optional(v.string()),
    role: v.optional(v.string()), // "admin" | "viewer"
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_email", ["email"]),

  sessions: defineTable({
    userId: v.id("users"),
    token: v.string(),
    expiresAt: v.number(),
    ipAddress: v.optional(v.string()),
    userAgent: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_token", ["token"])
    .index("by_userId", ["userId"]),

  accounts: defineTable({
    userId: v.id("users"),
    accountId: v.string(), // GitHub user ID
    providerId: v.string(), // "github"
    accessToken: v.optional(v.string()),
    refreshToken: v.optional(v.string()),
    accessTokenExpiresAt: v.optional(v.number()),
    refreshTokenExpiresAt: v.optional(v.number()),
    scope: v.optional(v.string()),
    idToken: v.optional(v.string()),
    password: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_providerId_accountId", ["providerId", "accountId"]),

  verifications: defineTable({
    identifier: v.string(),
    value: v.string(),
    expiresAt: v.number(),
    createdAt: v.optional(v.number()),
    updatedAt: v.optional(v.number()),
  }).index("by_identifier", ["identifier"]),

  // ── Vault tables ───────────────────────────────────────────────────

  vaultNotes: defineTable({
    path: v.string(), // relative path from vault root, e.g. "Projects/09-joelclaw/index.md"
    title: v.string(),
    content: v.string(), // markdown body (up to 32KB)
    html: v.optional(v.string()), // pre-rendered HTML (Obsidian-flavored)
    type: v.string(), // "adr", "project", "tool", "note", etc.
    tags: v.array(v.string()),
    section: v.string(), // top-level PARA section: "Projects", "Resources", etc.
    updatedAt: v.number(), // file mtime as unix epoch seconds
    syncedAt: v.number(), // when this record was last synced
  })
    .index("by_path", ["path"])
    .index("by_section", ["section"])
    .index("by_type", ["type"])
    .index("by_updatedAt", ["updatedAt"])
    .searchIndex("search_title_content", {
      searchField: "title",
      filterFields: ["section", "type"],
    }),

  // ── Memory tables ──────────────────────────────────────────────────

  memoryObservations: defineTable({
    observationId: v.string(), // Typesense doc ID for dedup
    observation: v.string(),
    category: v.string(), // "debugging", "architecture", "preference", etc.
    source: v.string(), // "pi", "claude", "codex", "gateway"
    sessionId: v.optional(v.string()),
    superseded: v.boolean(),
    timestamp: v.number(), // unix epoch seconds
    syncedAt: v.number(),
  })
    .index("by_observationId", ["observationId"])
    .index("by_category", ["category"])
    .index("by_timestamp", ["timestamp"])
    .index("by_source", ["source"])
    .searchIndex("search_observation", {
      searchField: "observation",
      filterFields: ["category", "source", "superseded"],
    }),

  systemLog: defineTable({
    entryId: v.string(), // dedup key (timestamp + action + tool)
    action: v.string(), // "install", "configure", "remove", "fix", etc.
    tool: v.string(),
    detail: v.string(),
    reason: v.optional(v.string()),
    timestamp: v.number(), // unix epoch seconds
    syncedAt: v.number(),
  })
    .index("by_entryId", ["entryId"])
    .index("by_timestamp", ["timestamp"])
    .index("by_tool", ["tool"])
    .index("by_action", ["action"])
    .searchIndex("search_detail", {
      searchField: "detail",
      filterFields: ["action", "tool"],
    }),

  // ── Unified content resources (ADR-0084) ───────────────────────────

  contentResources: defineTable({
    resourceId: v.string(), // deterministic, e.g. "vault:Projects/foo.md"
    type: v.string(), // discriminator: "vault_note", "memory_observation", etc.
    fields: v.any(), // type-specific payload bag
    searchText: v.string(), // concatenated searchable text from fields
    createdAt: v.number(),
    updatedAt: v.number(),
    deletedAt: v.optional(v.number()),
  })
    .index("by_resourceId", ["resourceId"])
    .index("by_type", ["type"])
    .index("by_type_updatedAt", ["type", "updatedAt"])
    .searchIndex("search_text", {
      searchField: "searchText",
      filterFields: ["type"],
    }),

  contentResourceResource: defineTable({
    parentId: v.string(), // resourceId of parent
    childId: v.string(), // resourceId of child
    position: v.optional(v.number()),
    metadata: v.optional(v.any()),
  })
    .index("by_parentId", ["parentId"])
    .index("by_childId", ["childId"]),

  // ── Feedback + Revision tables (ADR-0106) ────────────────────────

  feedbackItems: defineTable({
    resourceId: v.string(),
    content: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("processing"),
      v.literal("applied"),
      v.literal("failed"),
    ),
    authorId: v.optional(v.string()),
    createdAt: v.number(),
    resolvedAt: v.optional(v.number()),
  })
    .index("by_resource", ["resourceId"])
    .index("by_resource_status", ["resourceId", "status"]),

  contentRevisions: defineTable({
    resourceId: v.string(),
    revisionNumber: v.number(),
    content: v.string(),
    diff: v.optional(v.string()),
    feedbackIds: v.array(v.string()),
    agentModel: v.string(),
    createdAt: v.number(),
  })
    .index("by_resource", ["resourceId"])
    .index("by_resource_revision", ["resourceId", "revisionNumber"]),

  // ── Dashboard tables ──────────────────────────────────────────────

  systemStatus: defineTable({
    component: v.string(), // "redis", "inngest", "typesense", "pds", "livekit"
    status: v.union(v.literal("healthy"), v.literal("degraded"), v.literal("down")),
    detail: v.optional(v.string()),
    checkedAt: v.number(),
  }).index("by_component", ["component"]),

  notifications: defineTable({
    type: v.string(), // "deploy", "loop", "email", "observation", "error"
    title: v.string(),
    body: v.optional(v.string()),
    metadata: v.optional(v.any()),
    read: v.boolean(),
    createdAt: v.number(),
  }).index("by_createdAt", ["createdAt"]),

  // ── ADR Review Comments (ADR-0106) ────────────────────────────────

});
