import { inngest } from "../client";
import { infer } from "../../lib/inference";

const DEFAULT_SITE_URL = "https://joelclaw.com";

function normalizeSiteUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeSlug(value: string): string {
  return value.replace(/^\/+/, "");
}

function resolveAdrNumber(
  adrNumber: string | number | undefined,
  slug: string
): string | null {
  if (typeof adrNumber === "number" && Number.isFinite(adrNumber)) {
    return String(adrNumber);
  }
  if (typeof adrNumber === "string" && adrNumber.trim()) {
    return adrNumber.trim();
  }

  const match = slug.match(/^(\d{3,4})/);
  return match?.[1] ?? null;
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
      component: "x-content-hook",
      action: "x.content.hook.tweet",
      model: "claude-haiku",
    });
    const raw = text.text.trim();
    const cleaned = raw.replace(/^["']|["']$/g, "");
    return cleaned || fallback;
  } catch {
    return fallback;
  }
  }
}

export const xContentHook = inngest.createFunction(
  {
    id: "x-content-hook",
    name: "X Content Hook",
    retries: 0,
  },
  { event: "content/published" },
  async ({ event, step }) => {
    const { type, title, slug, adrNumber, status } = event.data;
    const siteUrl = normalizeSiteUrl(process.env.SITE_URL ?? DEFAULT_SITE_URL);
    const safeSlug = normalizeSlug(slug);

    if (type === "post") {
      const url = `${siteUrl}/${safeSlug}`;
      const text = await step.run("generate-post-tweet-text", async () =>
        generateTweetTextWithPi({
          url,
          contextDescription: `New blog post published: ${title}`,
          fallbackTitle: title,
        })
      );

      await step.sendEvent("request-x-post", {
        name: "x/post.requested",
        data: {
          text,
          url,
          category: "post",
        },
      });

      return { status: "requested", category: "post", text, url };
    }

    if (type === "adr") {
      if (status !== "shipped") {
        return { status: "skipped", reason: "adr status is not shipped" };
      }

      const number = resolveAdrNumber(adrNumber, safeSlug);
      if (!number) {
        return { status: "skipped", reason: "missing adr number" };
      }

      const url = `${siteUrl}/adrs/${safeSlug}`;
      const text = await step.run("generate-adr-tweet-text", async () =>
        generateTweetTextWithPi({
          url,
          contextDescription: `ADR-${number} shipped: ${title}. Status changed to shipped.`,
          fallbackTitle: title,
        })
      );

      await step.sendEvent("request-x-post", {
        name: "x/post.requested",
        data: {
          text,
          url,
          category: "adr",
        },
      });

      return { status: "requested", category: "adr", text, url };
    }

    return { status: "skipped", reason: `unsupported content type: ${type as string}` };
  }
);
