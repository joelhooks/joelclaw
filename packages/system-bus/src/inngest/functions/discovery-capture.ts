import { inngest } from "../client";
import { $ } from "bun";
import { DISCOVERY_PROMPT } from "../prompts/discovery";

const VAULT_DISCOVERIES = `${process.env.HOME}/Vault/Resources/discoveries`;

/**
 * Discovery Capture — investigates interesting finds and writes vault notes.
 *
 * Receives a URL and/or context. Does all the heavy lifting:
 * clone repos, extract articles, generate a compelling title,
 * decide tags/relevance, write vault note in Joel's voice, and slog.
 */
export const discoveryCapture = inngest.createFunction(
  {
    id: "discovery-capture",
    concurrency: { limit: 2 },
    retries: 1,
  },
  { event: "discovery/noted" },
  async ({ event, step }) => {
    const { url, context } = event.data;
    const today = new Date().toISOString().split("T")[0];

    // Step 1: Gather raw material
    const material = await step.run("investigate", async () => {
      let content = "";
      let sourceType = "unknown";

      if (url?.includes("github.com")) {
        sourceType = "repo";
        const tmpDir = `/tmp/discovery-${Date.now()}`;
        try {
          await $`git clone --depth 1 ${url} ${tmpDir} 2>/dev/null`.quiet();
          const readmePath = `${tmpDir}/README.md`;
          if (await Bun.file(readmePath).exists()) {
            const readme = await Bun.file(readmePath).text();
            content = readme.length > 8000 ? readme.slice(0, 8000) + "\n\n[truncated]" : readme;
          }
          const tree = await $`find ${tmpDir} -maxdepth 2 -not -path '*/.*' -not -path '*/node_modules/*' | head -40`.text();
          content += `\n\n## File Structure\n\`\`\`\n${tree}\n\`\`\``;
        } catch {
          content = `Could not clone ${url}.`;
        } finally {
          await $`rm -rf ${tmpDir}`.quiet();
        }
      } else if (url) {
        sourceType = "article";
        try {
          content = (await $`defuddle ${url} 2>/dev/null`.text()).slice(0, 8000);
        } catch {
          content = `Could not extract content from ${url}.`;
        }
      } else {
        sourceType = "idea";
        content = context ?? "No content provided.";
      }

      return { content, sourceType };
    });

    // Step 2: Let pi do everything — title, tags, analysis, vault note
    const result = await step.run("generate-note", async () => {
      const prompt = DISCOVERY_PROMPT({
        url: url ?? undefined,
        context: context ?? undefined,
        sourceType: material.sourceType ?? "unknown",
        sourceContent: material.content ?? "",
        today: today as string,
        vaultDir: VAULT_DISCOVERIES,
      });

      const output = await $`pi -p --no-session ${prompt}`
        .env({ ...process.env, TERM: "dumb" })
        .text();

      // Extract filename from pi's output
      const match = output.match(/DISCOVERY_WRITTEN:(.+)/);
      const noteName = match?.[1]?.trim() ?? `Discovery ${today}`;
      const vaultPath = `${VAULT_DISCOVERIES}/${noteName}.md`;

      return { noteName, vaultPath, piOutput: output.slice(-200) };
    });

    // Step 3: Verify + slog
    await step.run("slog-result", async () => {
      const exists = await Bun.file(result.vaultPath).exists();
      if (!exists) {
        console.error(`Discovery note not written: ${result.vaultPath}`);
        return;
      }

      // Read title from the written file
      const content = await Bun.file(result.vaultPath).text();
      const titleMatch = content.match(/^# (.+)$/m);
      const title = titleMatch?.[1] ?? result.noteName;

      await $`slog write --action noted --tool discovery --detail "${title}" --reason "vault:Resources/discoveries/${result.noteName}.md"`.quiet();
    });

    // Trigger sync to website
    await step.sendEvent("slog-result", {
      name: "discovery/captured",
      data: {
        vaultPath: result.vaultPath,
        topic: result.noteName,
        slug: result.noteName,
      },
    });

    return { status: "captured", ...result };
  }
);
