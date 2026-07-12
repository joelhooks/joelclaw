import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

const tier = v.union(v.literal("private"), v.literal("guest"), v.literal("public"), v.literal("synthetic"));

export const upsertSessionStart = mutation({
  args: { room: v.string(), tier, callerHash: v.string(), startedAt: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("sessions").withIndex("by_room", (q) => q.eq("room", args.room)).unique();
    const now = args.startedAt ?? Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        tier: args.tier,
        callerHash: args.callerHash,
        startedAt: now,
        endedAt: undefined,
        hangupReason: undefined,
        lastHeartbeat: now,
        turnCount: 0,
        transcriptTail: [],
      });
      return existing._id;
    }
    return ctx.db.insert("sessions", { ...args, startedAt: now, lastHeartbeat: now, turnCount: 0, transcriptTail: [] });
  },
});

export const heartbeat = mutation({
  args: { room: v.string(), ts: v.optional(v.number()) },
  handler: async (ctx, { room, ts }) => {
    const session = await ctx.db.query("sessions").withIndex("by_room", (q) => q.eq("room", room)).unique();
    if (session && session.endedAt === undefined) await ctx.db.patch(session._id, { lastHeartbeat: ts ?? Date.now() });
  },
});

export const addTurn = mutation({
  args: {
    room: v.string(), idx: v.optional(v.number()), eouDelayMs: v.optional(v.number()),
    llmTtftMs: v.optional(v.number()), ttsTtfbMs: v.optional(v.number()),
    toolCalls: v.optional(v.array(v.string())), transcriptLine: v.optional(v.string()), ts: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.query("sessions").withIndex("by_room", (q) => q.eq("room", args.room)).unique();
    if (!session) return null;
    const idx = args.idx ?? session.turnCount;
    const ts = args.ts ?? Date.now();
    const transcriptTail = args.transcriptLine
      ? [...session.transcriptTail, args.transcriptLine].slice(-12)
      : session.transcriptTail;
    await ctx.db.patch(session._id, { turnCount: Math.max(session.turnCount, idx + 1), lastHeartbeat: ts, transcriptTail });
    return ctx.db.insert("turns", {
      sessionRoom: args.room, idx, ts, eouDelayMs: args.eouDelayMs, llmTtftMs: args.llmTtftMs,
      ttsTtfbMs: args.ttsTtfbMs, toolCalls: args.toolCalls,
    });
  },
});

export const endSession = mutation({
  args: { room: v.string(), reason: v.optional(v.string()), endedAt: v.optional(v.number()) },
  handler: async (ctx, { room, reason, endedAt }) => {
    const session = await ctx.db.query("sessions").withIndex("by_room", (q) => q.eq("room", room)).unique();
    if (session) await ctx.db.patch(session._id, { endedAt: endedAt ?? Date.now(), hangupReason: reason });
  },
});

export const addAnalysis = mutation({
  args: {
    room: v.string(), objective: v.object({ turns: v.number(), durationS: v.number(), turnsPerMin: v.number() }),
    judgeStatus: v.union(v.literal("pending"), v.literal("done")),
    scores: v.optional(v.object({ coherence: v.number(), warmth: v.number(), notes: v.string() })),
    createdAt: v.optional(v.number()),
  },
  handler: (ctx, args) => ctx.db.insert("analyses", { ...args, createdAt: args.createdAt ?? Date.now() }),
});

export const activeSessions = query({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - 15_000;
    return (await ctx.db.query("sessions").order("desc").collect()).filter((s) => s.endedAt === undefined && s.lastHeartbeat >= cutoff);
  },
});

export const recentSessions = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => ctx.db.query("sessions").withIndex("by_started_at").order("desc").take(Math.min(limit ?? 30, 100)),
});

export const sessionDetail = query({
  args: { room: v.string() },
  handler: async (ctx, { room }) => {
    const session = await ctx.db.query("sessions").withIndex("by_room", (q) => q.eq("room", room)).unique();
    if (!session) return null;
    const [turns, analysis] = await Promise.all([
      ctx.db.query("turns").withIndex("by_room_idx", (q) => q.eq("sessionRoom", room)).collect(),
      ctx.db.query("analyses").withIndex("by_room", (q) => q.eq("room", room)).order("desc").first(),
    ]);
    return { session, turns, analysis };
  },
});

export const purgeOlderThan = mutation({
  args: { cutoff: v.number() },
  handler: async (ctx, { cutoff }) => {
    const sessions = await ctx.db.query("sessions").withIndex("by_started_at", (q) => q.lt("startedAt", cutoff)).collect();
    const turns = await ctx.db.query("turns").withIndex("by_ts", (q) => q.lt("ts", cutoff)).collect();
    const analyses = await ctx.db.query("analyses").withIndex("by_created_at", (q) => q.lt("createdAt", cutoff)).collect();
    await Promise.all([...sessions, ...turns, ...analyses].map((row) => ctx.db.delete(row._id)));
    return { sessions: sessions.length, turns: turns.length, analyses: analyses.length };
  },
});
