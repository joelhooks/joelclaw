import { inngest } from "../client";
import { $ } from "bun";

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

Preserve the frontmatter, info callout, and transcript sections unchanged.`;

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

    // Run pi in print mode — it reads the file, researches, and edits in place
    await step.run("pi-enrich", async () => {
      // pi -p with @file reads the file content into context
      // pi with tools will use edit/write to modify the file directly
      await $`pi -p --no-session "Read the file at ${vaultPath} and enrich it. ${summaryPrompt}"`
        .env({ ...process.env, TERM: "dumb" })
        .quiet();
    });

    // Log + emit
    await step.run("log-and-emit", async () => {
      await $`slog write --action summarize --tool content-summarize --detail "enriched: ${title}" --reason "content/summarize event via inngest"`.quiet();
    });

    await step.sendEvent("log-and-emit", {
      name: "content/summarized",
      data: { vaultPath, title },
    });

    return { vaultPath, title, status: "summarized" };
  }
);
