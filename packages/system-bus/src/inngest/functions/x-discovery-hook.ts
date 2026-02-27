import { infer } from "../../lib/inference";
import { inngest } from "../client";

function hasPublicTag(tags: string[] | undefined): boolean {
  if (!tags || tags.length === 0) return false;
  return tags.some((tag) => tag.trim().toLowerCase() === "public");
}

function createTweetPrompt(url: string, contextDescription: string): string {
  return `You are Panda, the joelclaw AI agent. Write a tweet (STRICT MAX 260 characters).
Voice: direct, terse, slightly dry - Joel's writing style but YOU are the author, not Joel.
Say "shipped", "wired up", "the system now does" - agent voice.
No emoji spam (one max). No hashtags. No "excited to announce" energy.
Include this URL at the end: ${url}
Output ONLY the tweet text, nothing else.

Context: ${contextDescription}`;
}

async function generateTweetTextWithPi({
  url,
  contextDescription,
  fallbackTitle,
}: {
  url: string;
  contextDescription: string;
  fallbackTitle: string;
}): Promise<string> {
  const fallback = `shipped: ${fallbackTitle} ${url}`;
  const prompt = createTweetPrompt(url, contextDescription);
  try {
    const text = await infer(prompt, {
      task: "summary",
      component: "x-discovery-hook",
      action: "x.discovery.hook.tweet",
      model: "claude-haiku",
    });
    const cleaned = text.text.trim().replace(/^["']|["']$/g, "");
    return cleaned || fallback;
  } catch {
    return fallback;
  }
}

export const xDiscoveryHook = inngest.createFunction(
  {
    id: "x-discovery-hook",
    name: "X Discovery Hook",
    retries: 0,
  },
  { event: "discovery/captured" },
  async ({ event, step }) => {
    const { url, title, tags } = event.data;

    if (!hasPublicTag(tags)) {
      return { status: "skipped", reason: "discovery is not tagged public" };
    }

    if (!url || !title) {
      return { status: "skipped", reason: "missing discovery title or url" };
    }

    const tagsText = tags && tags.length > 0 ? tags.join(", ") : "none";
    const text = await step.run("generate-discovery-tweet-text", async () =>
      generateTweetTextWithPi({
        url,
        contextDescription: `New discovery captured: ${title}. Source: ${url}. Tags: ${tagsText}.`,
        fallbackTitle: title,
      })
    );

    await step.sendEvent("request-x-post", {
      name: "x/post.requested",
      data: {
        text,
        url,
        category: "discovery",
      },
    });

    return { status: "requested", text, url };
  }
);
