import { inngest } from "../client";
import { $ } from "bun";

/**
 * Discovery Capture — investigates interesting finds and writes vault notes.
 *
 * Triggered by discovery/noted events. Clones repos, extracts articles,
 * generates a vault note in Joel's voice, and slogs the result.
 */
export const discoveryCapture = inngest.createFunction(
  {
    id: "discovery-capture",
    concurrency: { limit: 2 },
    retries: 1,
  },
  { event: "discovery/noted" },
  async ({ event, step }) => {
    const { url, topic, context, depth = "medium", tags = [] } = event.data;
    const slug = topic
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60);
    const vaultPath = `${process.env.HOME}/Vault/Resources/discoveries/${slug}.md`;
    const today = new Date().toISOString().split("T")[0];

    // Step 1: Investigate the source
    const investigation = await step.run("investigate", async () => {
      let content = "";

      if (url?.includes("github.com")) {
        // Clone and read README
        const tmpDir = `/tmp/discovery-${slug}`;
        try {
          await $`git clone --depth 1 ${url} ${tmpDir} 2>/dev/null`.quiet();
          const readmePath = `${tmpDir}/README.md`;
          const readmeExists = await Bun.file(readmePath).exists();
          if (readmeExists) {
            content = await Bun.file(readmePath).text();
            // Truncate large READMEs
            if (content.length > 8000) content = content.slice(0, 8000) + "\n\n[truncated]";
          }
          // Get repo structure
          const tree = await $`find ${tmpDir} -maxdepth 2 -not -path '*/\.*' -not -path '*/node_modules/*' | head -50`.text();
          content += `\n\n## File Structure\n\`\`\`\n${tree}\n\`\`\``;
        } catch {
          content = `Failed to clone ${url}. Using provided context only.`;
        } finally {
          await $`rm -rf ${tmpDir}`.quiet();
        }
      } else if (url) {
        // Extract article content with defuddle
        try {
          const extracted = await $`defuddle ${url} 2>/dev/null`.text();
          content = extracted.slice(0, 8000);
        } catch {
          // Fallback: just note the URL
          content = `URL: ${url}\nCould not extract content. Using provided context.`;
        }
      }

      return { content, hasSource: content.length > 0 };
    });

    // Step 2: Generate vault note via pi
    await step.run("generate-note", async () => {
      const tagString = tags.map((t: string) => `"${t}"`).join(", ");
      const depthInstruction = depth === "deep"
        ? "Cross-reference with active Vault projects in ~/Vault/Projects/. Check ADRs in ~/Vault/docs/decisions/. Note specific integration points with Joel's system. Suggest concrete next steps."
        : depth === "quick"
        ? "Keep it brief — 1-2 paragraphs, just capture the gist."
        : "Summarize key ideas, note relevance to Joel's system (agent loops, event bus, vault, memory).";

      const prompt = `Read the joel-writing-style skill at ~/.pi/agent/skills/joel-writing-style/SKILL.md first.

Write a discovery note to ${vaultPath}. Use this exact format:

---
type: discovery
source: "${url ?? "conversation"}"
discovered: "${today}"
tags: [${tagString}]
relevance: "[one-line on why this matters to Joel's system]"
---

# ${topic}

[2-4 paragraph summary in Joel's voice — direct, no throat-clearing, connect to Joel's system where relevant. Say what it is, why it's clever, and whether it's useful. Do NOT fabricate Joel's opinions — describe what it does and why it's notable.]

## Key Ideas

- [Bullet the notable concepts, patterns, or features]

## Links

- ${url ? `[Source](${url})` : "Conversation note"}
- [Any related references you find]

Context from conversation: ${context ?? "none provided"}

${investigation.hasSource ? `Source content for reference:\n${investigation.content}` : "No source content available — work from the context above."}

${depthInstruction}

IMPORTANT: Write the file directly with the write tool. Do not ask questions.`;

      await $`pi -p --no-session ${prompt}`
        .env({ ...process.env, TERM: "dumb" })
        .quiet();
    });

    // Step 3: Verify note was written + slog
    const result = await step.run("log-result", async () => {
      const exists = await Bun.file(vaultPath).exists();
      if (!exists) {
        return { status: "failed", reason: "vault note not written" };
      }

      await $`slog write --action noted --tool discovery --detail "${topic}" --reason "vault:Resources/discoveries/${slug}.md"`.quiet();

      return { status: "captured", vaultPath, slug };
    });

    return result;
  }
);
