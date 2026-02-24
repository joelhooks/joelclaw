import { inngest } from "../client";

function hasPublicTag(tags: string[] | undefined): boolean {
  if (!tags || tags.length === 0) return false;
  return tags.some((tag) => tag.trim().toLowerCase() === "public");
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

    const text = `Interesting: ${title}\n${url}`;

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
