import { inngest } from "../client";
import { $ } from "bun";

const VAULT_DISCOVERIES = `${process.env.HOME}/Vault/Resources/discoveries`;

/**
 * Discovery Capture — investigates interesting finds and writes vault notes.
 *
 * Receives a URL and/or context. Does all the heavy lifting:
 * clone repos, extract articles, decide tags/relevance, write vault note
 * in Joel's voice, and slog the result.
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

    // Step 2: Let pi do everything — analyze, tag, write the note
    const result = await step.run("generate-note", async () => {
      const prompt = `Read the joel-writing-style skill at ~/.pi/agent/skills/joel-writing-style/SKILL.md first.

You are writing a discovery note for Joel's Vault. Investigate this source material and write a complete vault note.

SOURCE: ${url ?? "conversation"}
JOEL SAID: ${context ?? "(just flagged it as interesting)"}
SOURCE TYPE: ${material.sourceType}
DATE: ${today}

SOURCE MATERIAL:
${material.content}

YOUR JOB:
1. Figure out a good short title and kebab-case slug for the filename
2. Decide relevant tags (source type, domain, tech)
3. Write a one-line relevance statement connecting it to Joel's system (agent loops, event bus, vault, memory, video pipeline, etc.)
4. Write 2-4 paragraphs in Joel's voice — direct, no filler, say what it is, why it's clever, and whether it's useful
5. Bullet key ideas
6. List links

Write the file to ${VAULT_DISCOVERIES}/{slug}.md using this format:

---
type: discovery
source: "${url ?? "conversation"}"
discovered: "${today}"
tags: [your-chosen-tags]
relevance: "your one-liner"
---

# {Title}

{Summary paragraphs}

## Key Ideas

- {bullets}

## Links

- {links}

After writing the file, print ONLY a single line: DISCOVERY_WRITTEN:{slug}
This is how I know you succeeded. Do NOT print anything else after.

IMPORTANT: Write the file with the write tool. Do not ask questions. Just do it.`;

      const output = await $`pi -p --no-session ${prompt}`
        .env({ ...process.env, TERM: "dumb" })
        .text();

      // Extract slug from pi's output
      const match = output.match(/DISCOVERY_WRITTEN:(.+)/);
      const slug = match?.[1]?.trim() ?? `discovery-${today}`;
      const vaultPath = `${VAULT_DISCOVERIES}/${slug}.md`;

      return { slug, vaultPath, piOutput: output.slice(-200) };
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
      const title = titleMatch?.[1] ?? result.slug;

      await $`slog write --action noted --tool discovery --detail "${title}" --reason "vault:Resources/discoveries/${result.slug}.md"`.quiet();
    });

    return { status: "captured", ...result };
  }
);
