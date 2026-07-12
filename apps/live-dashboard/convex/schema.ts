import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  sessions: defineTable({
    room: v.string(),
    tier: v.union(v.literal("private"), v.literal("guest"), v.literal("public"), v.literal("synthetic")),
    callerHash: v.string(),
    startedAt: v.number(),
    endedAt: v.optional(v.number()),
    hangupReason: v.optional(v.string()),
    lastHeartbeat: v.number(),
    turnCount: v.number(),
    transcriptTail: v.array(v.string()),
  }).index("by_room", ["room"]).index("by_started_at", ["startedAt"]),
  turns: defineTable({
    sessionRoom: v.string(),
    idx: v.number(),
    eouDelayMs: v.optional(v.number()),
    llmTtftMs: v.optional(v.number()),
    ttsTtfbMs: v.optional(v.number()),
    toolCalls: v.optional(v.array(v.string())),
    ts: v.number(),
  }).index("by_room_idx", ["sessionRoom", "idx"]).index("by_ts", ["ts"]),
  analyses: defineTable({
    room: v.string(),
    objective: v.object({ turns: v.number(), durationS: v.number(), turnsPerMin: v.number() }),
    judgeStatus: v.union(v.literal("pending"), v.literal("done")),
    scores: v.optional(v.object({ coherence: v.number(), warmth: v.number(), notes: v.string() })),
    createdAt: v.number(),
  }).index("by_room", ["room"]).index("by_created_at", ["createdAt"]),
});
