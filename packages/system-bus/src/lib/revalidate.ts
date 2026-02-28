/**
 * Revalidate Next.js cache tags/paths via the joelclaw.com API.
 * Shared by content-sync, content-review, and any pipeline that mutates content.
 */

function getSiteUrl(): string {
  const configured = process.env.SITE_URL?.trim() ?? "https://joelclaw.com";
  return configured.endsWith("/") ? configured.slice(0, -1) : configured;
}

export async function revalidateContentCache(args: {
  tags: string[];
  paths?: string[];
}): Promise<{ revalidated: boolean; tags: string[]; paths: string[] }> {
  const revalidationSecret = process.env.REVALIDATION_SECRET?.trim();
  if (!revalidationSecret) {
    console.warn("[revalidate] REVALIDATION_SECRET not set, skipping cache purge");
    return { revalidated: false, tags: [], paths: [] };
  }

  const tags = args.tags.filter((tag) => typeof tag === "string" && tag.trim().length > 0);
  const paths = (args.paths ?? []).filter(
    (path) => typeof path === "string" && path.trim().length > 0,
  );

  if (tags.length === 0 && paths.length === 0) {
    return { revalidated: false, tags: [], paths: [] };
  }

  const response = await fetch(`${getSiteUrl()}/api/revalidate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: revalidationSecret, tags, paths }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `revalidate failed (${response.status})${body ? `: ${body.slice(0, 300)}` : ""}`,
    );
  }

  return { revalidated: true, tags, paths };
}
