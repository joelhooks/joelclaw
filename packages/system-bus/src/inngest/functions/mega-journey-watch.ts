/**
 * MEGA post-merge journey watcher trigger.
 *
 * The mega-dev repo's browser journey (Playwright buy-flow proof) runs in
 * neither GitHub CI nor the pre-push hook — its enforcement authority is
 * scripts/journey-watch.sh in the mega-dev checkout on flagg. This function
 * turns the existing GitHub webhook ingress into the watcher's push trigger:
 * when the "MEGA gate" workflow completes for a push to main, run one tick.
 * The tick script owns all the hard parts: sha dedupe, single-flight lock,
 * retry-once flake law, evidence preservation, and joelclaw notification.
 * A 30-minute LaunchAgent poll (com.mega.journey-watch) remains the backstop
 * for missed webhook deliveries.
 *
 * Decision record:
 * mega-dev/.brain/projects/mega-course-platform/stabilize-journey-prepush-flake.svx
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { inngest } from "../client";

const execFileAsync = promisify(execFile);

const MEGA_REPO = "MEGA-DOT-DEV/mega-dev";
const WATCH_SCRIPT = "/Users/joel/Code/mega-dot-dev/mega-dev/scripts/journey-watch.sh";
const WATCH_PATH = [
  "/Users/joel/.local/share/fnm/aliases/default/bin",
  "/Users/joel/.bun/bin",
  "/opt/homebrew/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
].join(":");

export const megaJourneyWatch = inngest.createFunction(
  {
    id: "mega-journey-watch",
    name: "MEGA → Journey Watch: post-merge browser proof",
    concurrency: { limit: 1 },
    retries: 1,
  },
  { event: "github/workflow_run.completed" },
  async ({ event, step }) => {
    const { repository, branch, event: trigger, headSha, conclusion } = event.data;

    if (repository !== MEGA_REPO || branch !== "main" || trigger !== "push") {
      return { status: "skipped", reason: "not a mega-dev main push", repository, branch, trigger };
    }

    const tick = await step.run("journey-watch-tick", async () => {
      // The script exits 1 when main is red after its own retry — it has
      // already notified by then. Retried runs are no-ops via sha dedupe.
      const { stdout, stderr } = await execFileAsync("/bin/bash", [WATCH_SCRIPT], {
        env: { ...process.env, PATH: WATCH_PATH },
        maxBuffer: 8 * 1024 * 1024,
        timeout: 20 * 60 * 1000,
      });
      return {
        stdout: stdout.slice(-2000),
        stderr: stderr.slice(-2000),
      };
    });

    return { status: "ticked", headSha, conclusion, tick };
  },
);
