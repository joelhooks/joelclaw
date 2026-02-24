import { inngest } from "../client";

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
      const text = `New: ${title}\n${url}`;

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
      const text = `ADR-${number} shipped: ${title}\n${url}`;

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
