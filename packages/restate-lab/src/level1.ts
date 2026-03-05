/**
 * Restate Lab — Level 1: Observable Durable Steps
 *
 * A service with 5 steps that each write a marker file.
 * Kill the worker between steps → restart → it resumes where it left off.
 *
 * The whole point: ctx.run() is the durability boundary.
 * Once a step completes, Restate journals the result.
 * On replay, completed steps return their journaled result
 * WITHOUT re-executing the closure.
 */

import * as restate from "@restatedev/restate-sdk";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const MARKER_DIR = join(import.meta.dir, "../.markers");

// Ensure marker directory exists
mkdirSync(MARKER_DIR, { recursive: true });

function writeMarker(step: number, data: Record<string, unknown>) {
  const path = join(MARKER_DIR, `step-${step}.json`);
  writeFileSync(path, JSON.stringify({ ...data, writtenAt: new Date().toISOString() }, null, 2));
  console.log(`✅ Step ${step} EXECUTED — wrote ${path}`);
}

/**
 * Level 1: Five durable steps, each writes a file.
 *
 * Kill test:
 *   1. Start the worker: bun run lab
 *   2. Send a request: bun run send
 *   3. Watch steps execute (1s delay between each)
 *   4. Kill the worker (Ctrl+C) after step 2 or 3
 *   5. Restart: bun run lab
 *   6. Watch — it resumes from the NEXT uncompleted step
 *   7. Check .markers/ — no duplicate writes
 */
export const labService = restate.service({
  name: "labService",
  handlers: {
    durableSteps: async (ctx: restate.Context, input: { runId: string }) => {
      console.log(`\n🔬 Starting durable steps — runId: ${input.runId}`);
      console.log(`   PID: ${process.pid} — kill me between steps to test durability\n`);

      // Step 1: Prepare
      const step1 = await ctx.run("step-1-prepare", () => {
        const result = { step: 1, runId: input.runId, action: "prepare", pid: process.pid };
        writeMarker(1, result);
        return result;
      });

      // Artificial delay so you can kill between steps
      await ctx.sleep({ milliseconds: 2000 });

      // Step 2: Fetch (simulated)
      const step2 = await ctx.run("step-2-fetch", () => {
        const result = { step: 2, runId: input.runId, action: "fetch", data: "some-payload", pid: process.pid };
        writeMarker(2, result);
        return result;
      });

      await ctx.sleep({ milliseconds: 2000 });

      // Step 3: Transform
      const step3 = await ctx.run("step-3-transform", () => {
        const result = { step: 3, runId: input.runId, action: "transform", transformed: step2.data.toUpperCase(), pid: process.pid };
        writeMarker(3, result);
        return result;
      });

      await ctx.sleep({ milliseconds: 2000 });

      // Step 4: Persist
      const step4 = await ctx.run("step-4-persist", () => {
        const result = { step: 4, runId: input.runId, action: "persist", stored: step3.transformed, pid: process.pid };
        writeMarker(4, result);
        return result;
      });

      await ctx.sleep({ milliseconds: 2000 });

      // Step 5: Complete
      const step5 = await ctx.run("step-5-complete", () => {
        const result = {
          step: 5,
          runId: input.runId,
          action: "complete",
          summary: `Processed "${step2.data}" → "${step3.transformed}" → stored`,
          allPids: [step1.pid, step2.pid, step3.pid, step4.pid, process.pid],
          pid: process.pid,
        };
        writeMarker(5, result);
        return result;
      });

      console.log(`\n🏁 All 5 steps complete for runId: ${input.runId}`);
      console.log(`   PIDs across steps: ${step5.allPids.join(", ")}`);
      console.log(`   If PIDs differ, the worker was killed and restarted mid-run!\n`);

      return step5;
    },
  },
});
