import { syncPiMonoArtifacts } from "../../packages/restate/src/pi-mono-artifacts";
import { runDailyDigest } from "../../packages/system-bus/src/inngest/functions/daily-digest";
import {
  runSkillGardenAudit,
} from "../../packages/system-bus/src/inngest/functions/skill-garden";
import { runSubscriptionCheckFeeds } from "../../packages/system-bus/src/inngest/functions/subscriptions";
import {
  indexBlogPosts,
  indexSystemLog,
  indexVaultNotes,
  runTypesenseFullSync,
  syncSystemKnowledge,
} from "../../packages/system-bus/src/inngest/functions/typesense-sync";

const args = process.argv.slice(2);
const getArg = (flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

const task = getArg("--task")?.trim();
const argsJson = getArg("--args-json")?.trim() ?? "{}";

if (!task) {
  console.error("Missing required --task");
  process.exit(1);
}

let parsedArgs: Record<string, unknown> = {};
try {
  parsedArgs = JSON.parse(argsJson);
} catch (error) {
  console.error(`Invalid --args-json payload: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

async function run() {
  switch (task) {
    case "skill-garden":
      return runSkillGardenAudit({
        deep: parsedArgs.deep === true,
      });

    case "typesense-vault-sync":
      return indexVaultNotes();

    case "typesense-blog-sync":
      return indexBlogPosts();

    case "typesense-system-log-sync":
      return indexSystemLog();

    case "typesense-system-knowledge-sync":
      return syncSystemKnowledge();

    case "typesense-full-sync":
      return runTypesenseFullSync();

    case "daily-digest":
      return runDailyDigest();

    case "subscription-check-feeds":
      return runSubscriptionCheckFeeds({
        forceAll: parsedArgs.forceAll === true,
        source: typeof parsedArgs.source === "string" ? parsedArgs.source : "restate/dkron",
      });

    case "pi-mono-artifacts-sync":
      return syncPiMonoArtifacts({
        repo: typeof parsedArgs.repo === "string" ? parsedArgs.repo : undefined,
        localClonePath: typeof parsedArgs.localClonePath === "string" ? parsedArgs.localClonePath : undefined,
        fullBackfill: parsedArgs.fullBackfill === true,
        maxPages: typeof parsedArgs.maxPages === "number" ? parsedArgs.maxPages : undefined,
        perPage: typeof parsedArgs.perPage === "number" ? parsedArgs.perPage : undefined,
        materializeProfile: parsedArgs.materializeProfile !== false,
      });

    default:
      throw new Error(`Unknown tier-1 task: ${task}`);
  }
}

try {
  const result = await run();
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
