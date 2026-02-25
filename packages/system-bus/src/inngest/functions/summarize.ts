import { inngest } from "../client";
import { infer } from "../../lib/inference";
import { pushGatewayEvent } from "./agent-loop/utils";
import { prefetchMemoryContext } from "../../memory/context-prefetch";

const DEFAULT_PROMPT = `Read the joel-writing-style skill at ~/.pi/agent/skills/joel-writing-style/SKILL.md first. All writing in this note MUST match Joel's voice — conversational first person, short punchy paragraphs, strategic profanity where it earns its place, bold for emphasis, direct and honest tone. No corporate voice. No "In this video..." openings.

Read this vault note. Enrich it using your full tool set — search the web for the speaker/author, the event/publication, projects and people mentioned, related work. Add hyperlinks to EVERYTHING that can be linked: people, companies, projects, conferences, papers, repos, related talks.

Edit the note in place. Replace the Executive Summary / Key Points sections (or the TODO placeholder) with:

## Executive Summary
2-3 paragraphs in Joel's voice. Core argument, significance, why it matters. Rich with context from your research. Write like you're telling a friend about it, not writing a book report.

## Key Points
- Bullet the main ideas. Each bullet should be self-contained and useful standalone.

## Speaker Context
Who is this person? Background, previous work, current role. Link to profiles, companies, projects.

## Notable Quotes
> Blockquoted memorable lines

## Related
- Hyperlinked list of related talks, projects, papers, articles, repos mentioned or discovered.

## Tags
Comma-separated topic tags for vault indexing.

Preserve the frontmatter, info callout, and transcript sections unchanged.

SCREENSHOTS: If there's a Key Moments section with screenshot images, DO NOT leave them bunched together. Dissolve that section entirely — move each screenshot inline into the Executive Summary or Key Points where it's contextually relevant. Place each image immediately after the paragraph or bullet that discusses what's shown in that frame. Use the timestamp and filename as clues for what the screenshot depicts. Delete the Key Moments heading when done — every image should live inside the content, not in a separate gallery.`;

/**
 * Content Summarize — enriches any vault note using pi with full tools.
 *
 * Pi reads the file, researches the web, and edits the note in place.
 * Works on video transcripts, meeting notes, articles — anything in the vault.
 */
export const summarize = inngest.createFunction(
  {
    id: "content-summarize",
    concurrency: { limit: 1 },
    retries: 1,
  },
  { event: "content/summarize.requested" },
  async ({ event, step }) => {
    const { vaultPath, prompt } = event.data;
    const summaryPrompt = prompt ?? DEFAULT_PROMPT;

    // Extract title before pi runs (for logging)
    const title = await step.run("read-title", async () => {
      const content = await Bun.file(vaultPath).text();
      const match = content.match(/^# (.+)$/m);
      return match?.[1] ?? vaultPath.split("/").pop() ?? "unknown";
    });

    const memoryContext = await step.run("prefetch-memory", async () =>
      prefetchMemoryContext(title, { limit: 5 })
    );
    const promptWithMemory = memoryContext
      ? `${summaryPrompt}\n\nPrevious related memory:\n${memoryContext}`
      : summaryPrompt;

    // Run inference and rewrite the note locally from returned markdown.
    await step.run("pi-enrich", async () => {
      const sourceContent = await Bun.file(vaultPath).text();
      const summaryInstruction = `Read this vault note and enrich it in place.
${promptWithMemory}

Original note:
${sourceContent}

Return ONLY the full updated markdown and do not include extra explanations.`;

      const result = await infer(summaryInstruction, {
        task: "summary",
        component: "summarize",
        action: "content.summarize.enrich",
        timeout: 120_000,
      });

      const updated = result.text.trim();
      if (!updated) {
        throw new Error("summarize returned empty output");
      }

      await Bun.write(vaultPath, `${updated}\n`);
    });

    // Log + emit
    await step.run("log-and-emit", async () => {
      await $`slog write --action summarize --tool content-summarize --detail "enriched: ${title}" --reason "content/summarize event via inngest"`.quiet();
    });

    await step.sendEvent("log-and-emit", {
      name: "content/summarized",
      data: { vaultPath, title },
    });

    await step.run("notify-gateway", async () => {
      try {
        await pushGatewayEvent({
          type: "content.summarized",
          source: "inngest",
          payload: {
            title,
            vaultPath,
            prompt: `Video "${title}" has been fully ingested — downloaded, transcribed, and summarized with key moment screenshots. The enriched vault note is at ${vaultPath}. Let Joel know it's ready.`,
          },
        });
      } catch {}
    });

    return { vaultPath, title, status: "summarized" };
  }
);
