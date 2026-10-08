/**
 * Session retention report — count old session files without deleting them.
 * Extracted from heartbeat for independent retry/scheduling.
 */

import { pruneOldSessionFiles } from "../../lib/session-prune";
import { inngest } from "../client";

export const checkSessions = inngest.createFunction(
  { id: "check/sessions-prune", concurrency: { limit: 1 }, retries: 1 },
  { event: "sessions/prune.requested" },
  async ({ step }) => {
    const result = await step.run("report-old-sessions", () => pruneOldSessionFiles());

    return {
      status: "reported",
      ...result,
      wouldPruneSessions: result.piSessionFilesWouldPrune,
      wouldPruneDebug: result.claudeDebugFilesWouldPrune,
      totalWouldPrune: result.filesWouldPrune,
    };
  },
);
