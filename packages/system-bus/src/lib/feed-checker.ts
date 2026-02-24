import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";

export interface FeedEntry {
  id: string;
  title: string;
  url?: string;
  publishedAt?: string;
  summary?: string;
  content?: string;
}

export interface FeedCheckResult {
  hasChanges: boolean;
  newEntries: FeedEntry[];
  contentHash?: string;
  latestEntryId?: string;
}

type GitHubRelease = {
  id?: number;
  tag_name?: string;
  name?: string;
  html_url?: string;
  published_at?: string;
  created_at?: string;
  body?: string;
};

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  trimValues: true,
  parseTagValue: false,
});

const MAX_NEW_ENTRIES = 25;
const PAGE_CONTENT_LIMIT = 20_000;

function toArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  const record = asRecord(value);
  if (!record) return null;

  const textValue = record["#text"];
  if (typeof textValue === "string" && textValue.trim().length > 0) {
    return textValue.trim();
  }

  return null;
}

function extractLink(value: unknown): string | undefined {
  const direct = asString(value);
  if (direct) return direct;

  for (const item of toArray(value)) {
    const record = asRecord(item);
    if (!record) continue;

    const href = asString(record["@_href"]);
    if (href) {
      const rel = asString(record["@_rel"]);
      if (!rel || rel === "alternate") return href;
    }
  }

  return undefined;
}

function toIsoOrUndefined(value: unknown): string | undefined {
  const raw = asString(value);
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(parsed).toISOString();
}

function normalizeEntryId(entry: FeedEntry): string {
  if (entry.id.trim().length > 0) return entry.id;
  if (entry.url && entry.url.trim().length > 0) return entry.url.trim();
  if (entry.title.trim().length > 0) return entry.title.trim();
  return `entry-${Date.now()}`;
}

function sortNewestFirst(entries: FeedEntry[]): FeedEntry[] {
  return [...entries].sort((a, b) => {
    const aTs = a.publishedAt ? Date.parse(a.publishedAt) : Number.NaN;
    const bTs = b.publishedAt ? Date.parse(b.publishedAt) : Number.NaN;

    if (Number.isFinite(aTs) && Number.isFinite(bTs)) return bTs - aTs;
    if (Number.isFinite(aTs)) return -1;
    if (Number.isFinite(bTs)) return 1;
    return 0;
  });
}

function sliceNewEntries(entries: FeedEntry[], lastEntryId?: string): FeedEntry[] {
  if (entries.length === 0) return [];
  if (!lastEntryId) return entries.slice(0, MAX_NEW_ENTRIES);

  const index = entries.findIndex((entry) => entry.id === lastEntryId);
  if (index === -1) {
    return entries.slice(0, MAX_NEW_ENTRIES);
  }

  return entries.slice(0, index);
}

function parseAtomOrRss(xml: string): FeedEntry[] {
  const parsed = xmlParser.parse(xml) as Record<string, unknown>;

  const feed = asRecord(parsed.feed);
  if (feed) {
    const atomEntries = toArray(feed.entry).map((entry): FeedEntry | null => {
      const record = asRecord(entry);
      if (!record) return null;

      const link = extractLink(record.link);
      const title = asString(record.title) ?? "Untitled";
      const id = asString(record.id) ?? link ?? title;

      return {
        id,
        title,
        url: link,
        publishedAt: toIsoOrUndefined(record.updated) ?? toIsoOrUndefined(record.published),
        summary: asString(record.summary) ?? asString(record.content) ?? undefined,
      };
    });

    return atomEntries
      .filter((entry): entry is FeedEntry => entry !== null)
      .map((entry) => ({ ...entry, id: normalizeEntryId(entry) }));
  }

  const rss = asRecord(parsed.rss);
  const channel = rss ? asRecord(rss.channel) : null;
  if (channel) {
    const rssEntries = toArray(channel.item).map((item): FeedEntry | null => {
      const record = asRecord(item);
      if (!record) return null;

      const link = extractLink(record.link);
      const title = asString(record.title) ?? "Untitled";
      const guid = asString(record.guid);
      const id = guid ?? link ?? title;

      return {
        id,
        title,
        url: link,
        publishedAt: toIsoOrUndefined(record.pubDate) ?? toIsoOrUndefined(record.date),
        summary:
          asString(record.description)
          ?? asString(record["content:encoded"])
          ?? undefined,
      };
    });

    return rssEntries
      .filter((entry): entry is FeedEntry => entry !== null)
      .map((entry) => ({ ...entry, id: normalizeEntryId(entry) }));
  }

  return [];
}

function sanitizePageText(raw: string): string {
  const noScript = raw
    .replace(/<script[\s\S]*?<\/script>/giu, " ")
    .replace(/<style[\s\S]*?<\/style>/giu, " ");

  const stripped = noScript
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/gu, " ")
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/\s+/gu, " ")
    .trim();

  return stripped.slice(0, PAGE_CONTENT_LIMIT);
}

async function fetchWithDefuddle(url: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["defuddle", url], {
      env: { ...process.env, TERM: "dumb" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) return null;
    const text = stdout.trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "joelclaw-feed-checker/1.0",
      Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.8",
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} while fetching ${url}: ${body.slice(0, 280)}`);
  }

  return await response.text();
}

export function parseGitHubRepo(input: string): { owner: string; repo: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const directMatch = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u.exec(trimmed);
  if (directMatch) {
    return { owner: directMatch[1]!, repo: directMatch[2]!.replace(/\.git$/u, "") };
  }

  try {
    const url = new URL(trimmed);
    if (url.hostname !== "github.com") return null;
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length < 2) return null;

    return {
      owner: segments[0]!,
      repo: segments[1]!.replace(/\.git$/u, ""),
    };
  } catch {
    return null;
  }
}

export async function checkAtomFeed(
  url: string,
  lastEntryId?: string
): Promise<FeedCheckResult> {
  const raw = await fetchText(url);
  const entries = sortNewestFirst(parseAtomOrRss(raw));
  const latestEntryId = entries[0]?.id;
  const newEntries = sliceNewEntries(entries, lastEntryId);

  return {
    hasChanges: newEntries.length > 0,
    newEntries,
    latestEntryId,
  };
}

export async function checkGitHubRepo(
  owner: string,
  repo: string,
  lastEntryId?: string
): Promise<FeedCheckResult> {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/releases?per_page=20`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "joelclaw-feed-checker/1.0",
      },
    }
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `GitHub API error ${response.status} for ${owner}/${repo}: ${body.slice(0, 280)}`
    );
  }

  const releases = (await response.json()) as GitHubRelease[];

  const entries = sortNewestFirst(
    releases.map((release) => {
      const id = String(release.id ?? release.tag_name ?? release.name ?? release.html_url ?? "");
      const title = release.name?.trim() || release.tag_name?.trim() || "Untitled release";

      return {
        id,
        title,
        url: release.html_url,
        publishedAt: toIsoOrUndefined(release.published_at) ?? toIsoOrUndefined(release.created_at),
        summary: release.body?.trim().slice(0, 1200),
      } satisfies FeedEntry;
    })
      .filter((entry) => entry.id.trim().length > 0)
      .map((entry) => ({ ...entry, id: normalizeEntryId(entry) }))
  );

  const latestEntryId = entries[0]?.id;
  const newEntries = sliceNewEntries(entries, lastEntryId);

  return {
    hasChanges: newEntries.length > 0,
    newEntries,
    latestEntryId,
  };
}

export async function checkPageHash(
  url: string,
  lastContentHash?: string
): Promise<FeedCheckResult> {
  const defuddled = await fetchWithDefuddle(url);
  const raw = defuddled ?? (await fetchText(url));
  const content = sanitizePageText(raw);
  const contentHash = createHash("sha256").update(content).digest("hex");

  const changed = !lastContentHash || lastContentHash !== contentHash;

  return {
    hasChanges: changed,
    newEntries: changed
      ? [
          {
            id: contentHash,
            title: "Page content updated",
            url,
            summary: content.slice(0, 1200),
            content,
          },
        ]
      : [],
    contentHash,
    latestEntryId: contentHash,
  };
}
