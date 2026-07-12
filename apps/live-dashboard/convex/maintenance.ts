import { internalMutation } from "./_generated/server";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export const purgeExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - RETENTION_MS;
    const sessions = await ctx.db.query("sessions").withIndex("by_started_at", (q) => q.lt("startedAt", cutoff)).collect();
    const turns = await ctx.db.query("turns").withIndex("by_ts", (q) => q.lt("ts", cutoff)).collect();
    const analyses = await ctx.db.query("analyses").withIndex("by_created_at", (q) => q.lt("createdAt", cutoff)).collect();
    await Promise.all([...sessions, ...turns, ...analyses].map((row) => ctx.db.delete(row._id)));
    return { sessions: sessions.length, turns: turns.length, analyses: analyses.length };
  },
});
