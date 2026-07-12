import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { inngest } from "../client";

type PublicCallData = {
  transcript?: unknown;
  room?: unknown;
  caller?: unknown;
  duration_s?: unknown;
  turns?: unknown;
  timestamp?: unknown;
};

const addAnalysis = makeFunctionReference<
  "mutation",
  { room: string; objective: { turns: number; durationS: number; turnsPerMin: number }; judgeStatus: "pending"; createdAt: number },
  unknown
>("calls:addAnalysis");

function finiteNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? "0"));
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

export const voicePublicCallAnalyze = inngest.createFunction(
  { id: "voice-public-call-analyze", name: "Public Voice Call → Quality Analysis", retries: 2 },
  { event: "voice/public-call.completed" },
  async ({ event, step }) => {
    const analysis = await step.run("compute-objective-stats", () => {
      const data = (event.data ?? {}) as PublicCallData;
      const room = typeof data.room === "string" ? data.room.trim() : "";
      if (!room) throw new Error("voice/public-call.completed missing room");
      const turns = Math.floor(finiteNumber(data.turns));
      const durationS = finiteNumber(data.duration_s);
      return {
        room,
        objective: {
          turns,
          durationS,
          turnsPerMin: durationS > 0 ? Number(((turns * 60) / durationS).toFixed(2)) : 0,
        },
        createdAt: Date.parse(String(data.timestamp ?? "")) || Date.now(),
      };
    });

    await step.run("write-pending-analysis", async () => {
      // Host worker runs on flagg beside the Convex backend; env overrides for anything else.
      const url = process.env.CONVEX_URL?.trim() || "http://127.0.0.1:3210";
      const client = new ConvexHttpClient(url);
      const adminKey = process.env.CONVEX_ADMIN_KEY?.trim();
      if (adminKey) client.setAdminAuth(adminKey);
      await client.mutation(addAnalysis, { ...analysis, judgeStatus: "pending" });
    });

    // TODO: add rubric judging through the repo's pi inference path once this
    // event can safely pass transcript text without introducing a paid provider.
    return { room: analysis.room, objective: analysis.objective, judgeStatus: "pending" };
  },
);
