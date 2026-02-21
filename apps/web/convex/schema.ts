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
});
