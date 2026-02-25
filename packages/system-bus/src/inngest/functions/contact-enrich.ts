import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { NonRetriableError } from "inngest";
import { emitOtelEvent } from "../../observability/emit";
import { infer } from "../../lib/inference";
import { inngest } from "../client";

const HOME_DIR = process.env.HOME?.trim() || "/Users/joel";
const VAULT_ROOT = process.env.VAULT_PATH?.trim() || `${HOME_DIR}/Vault`;
const CONTACTS_DIR = join(VAULT_ROOT, "Contacts");
const ROAM_ARCHIVE_PATH =
  `${HOME_DIR}/Code/joelhooks/egghead-roam-research/egghead-2026-01-19-13-09-38.edn`;
const TYPESENSE_HOST = "http://localhost:8108";
const QDRANT_HOST = "http://localhost:6333";
const FALLBACK_TYPESENSE_API_KEY =
  "391a65d92ff0b1d63af0e0d6cca04fdff292b765d833a65a25fb928b8a0fb065";

type ContactHints = {
  slack_user_id?: string;
  github?: string;
  twitter?: string;
  email?: string;
  website?: string;
};

type StepResult<T> = {
  ok: boolean;
  skipped?: boolean;
  error?: string;
  data: T;
};

type ExistingContact = {
  path: string | null;
  markdown: string | null;
};

type SlackMessage = {
  ts: string;
  user?: string;
  text?: string;
};

type SlackUserSummary = {
  id: string;
  name: string;
  realName?: string;
  displayName?: string;
  email?: string;
};

type SlackChannelSummary = {
  id: string;
  name: string;
  isPrivate: boolean;
  isIm: boolean;
  isMpim: boolean;
};

type SlackSearchData = {
  user: SlackUserSummary | null;
  channels: SlackChannelSummary[];
  dmChannelId: string | null;
  dmMessages: SlackMessage[];
};

type RoamSearchData = {
  archivePath: string;
  title_matches: Array<{ line: number; value: string }>;
  block_matches: Array<{ line: number; value: string }>;
};

type WebSearchData = {
  github: Record<string, unknown> | null;
  website: {
    url: string;
    title: string | null;
    description: string | null;
    headings: string[];
    excerpt: string;
  } | null;
};

type GranolaSearchData = {
  query: string;
  result: unknown;
};

type QdrantSearchHit = {
  id: string;
  score: number;
  payload: Record<string, unknown>;
};

type MemorySearchData = {
  collection: "session_observations";
  model: "nomic-embed-text-v1.5";
  vectorDimensions: number;
  hits: QdrantSearchHit[];
};

type TypesenseSearchCollection = {
  collection: string;
  found: number;
  query_by: string;
  hits: Array<Record<string, unknown>>;
};

type TypesenseSearchData = {
  collections: TypesenseSearchCollection[];
};

type OpenRouterResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
  usage?: Record<string, unknown>;
};

type SlackApiBase = {
  ok: boolean;
  error?: string;
  response_metadata?: {
    next_cursor?: string;
  };
};

type SlackUsersListResponse = SlackApiBase & {
  members?: SlackUserMember[];
};

type SlackUserMember = {
  id?: string;
  deleted?: boolean;
  is_bot?: boolean;
  name?: string;
  real_name?: string;
  profile?: {
    display_name?: string;
    real_name?: string;
    email?: string;
  };
};

type SlackConversationsListResponse = SlackApiBase & {
  channels?: Array<{
    id?: string;
    name?: string;
    is_private?: boolean;
    is_im?: boolean;
    is_mpim?: boolean;
  }>;
};

type SlackConversationsMembersResponse = SlackApiBase & {
  members?: string[];
};

type SlackConversationsOpenResponse = SlackApiBase & {
  channel?: {
    id?: string;
  };
};

type SlackConversationsHistoryResponse = SlackApiBase & {
  messages?: Array<{
    ts?: string;
    user?: string;
    text?: string;
  }>;
};

const ROAM_SEARCH_SCRIPT = String.raw`
import json, re, sys

path = sys.argv[1]
query = sys.argv[2].strip().lower()
limit = 40
title_matches = []
block_matches = []

def clean(value):
    try:
        return bytes(value, "utf-8").decode("unicode_escape")
    except Exception:
        return value

title_pattern = re.compile(r':node/title\\s+"((?:[^"\\\\]|\\\\.)*)"')
block_pattern = re.compile(r':block/string\\s+"((?:[^"\\\\]|\\\\.)*)"')

with open(path, "r", encoding="utf-8", errors="ignore") as handle:
    for line_number, line in enumerate(handle, 1):
        if ":node/title" in line:
            title_match = title_pattern.search(line)
            if title_match:
                value = clean(title_match.group(1))
                if query in value.lower():
                    title_matches.append({"line": line_number, "value": value[:500]})

        if ":block/string" in line:
            block_match = block_pattern.search(line)
            if block_match:
                value = clean(block_match.group(1))
                if query in value.lower():
                    block_matches.append({"line": line_number, "value": value[:500]})

        if len(title_matches) >= limit and len(block_matches) >= limit:
            break

print(json.dumps({
    "archivePath": path,
    "title_matches": title_matches[:limit],
    "block_matches": block_matches[:limit]
}))
`;

const NOMIC_EMBED_SCRIPT = String.raw`
import json, sys
from sentence_transformers import SentenceTransformer

text = sys.argv[1]
model = SentenceTransformer("nomic-ai/nomic-embed-text-v1.5")
vector = model.encode([f"search_query: {text}"], normalize_embeddings=True)[0]
print(json.dumps(vector.tolist()))
`;

const SYNTHESIZE_SYSTEM_PROMPT = `You maintain Vault contact dossiers.
Return ONLY markdown with YAML frontmatter and no code fences.

Required output format:
---
name: <full name>
aliases: [<optional aliases>]
role: <best current role summary>
organizations: [<orgs>]
vip: <true|false>
slack_user_id: <optional>
slack_dm_channel: <optional>
website: <optional>
github: <optional>
twitter: <optional>
email: <optional>
tags: [<tags>]
---

# <Name>
## Contact Channels
- include discovered channels/handles

## Projects
- summarize relevant projects

## Key Context
- concise relationship and working context

## Recent Activity
- bullet timeline in YYYY-MM-DD format when possible

Rules:
- Merge with existing file when present.
- Keep factual claims grounded in provided evidence; do not invent.
- If uncertain, mark as "Unverified".
- Preserve useful existing facts unless contradicted by newer evidence.`;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function trimTo(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}…`;
}

function sanitizeContactFileName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "unknown-contact";
  return trimmed.replace(/[\\/]/g, "-");
}

function resolveVaultPath(name: string, vaultPath?: string): string {
  if (vaultPath && vaultPath.trim()) {
    const provided = vaultPath.trim();
    return isAbsolute(provided) ? provided : join(VAULT_ROOT, provided);
  }
  return join(CONTACTS_DIR, `${sanitizeContactFileName(name)}.md`);
}

function resolveTypesenseApiKey(): string {
  const envKey = process.env.TYPESENSE_API_KEY?.trim();
  if (envKey) return envKey;
  try {
    return leaseSecret("typesense_api_key", "15m");
  } catch {
    return FALLBACK_TYPESENSE_API_KEY;
  }
}

function leaseSecret(name: string, ttl = "1h"): string {
  const result = spawnSync("secrets", ["lease", name, "--ttl", ttl], {
    encoding: "utf-8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    throw new Error(`Failed leasing ${name}: ${stderr || `exit ${result.status ?? "unknown"}`}`);
  }

  const token = (result.stdout ?? "").trim();
  if (!token) {
    throw new Error(`secrets lease returned empty value for ${name}`);
  }

  return token;
}

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  return new Response(stream).text();
}

function parseJsonFromText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {}

  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  if (objectStart !== -1 && objectEnd > objectStart) {
    try {
      return JSON.parse(trimmed.slice(objectStart, objectEnd + 1));
    } catch {}
  }

  const listStart = trimmed.indexOf("[");
  const listEnd = trimmed.lastIndexOf("]");
  if (listStart !== -1 && listEnd > listStart) {
    try {
      return JSON.parse(trimmed.slice(listStart, listEnd + 1));
    } catch {}
  }

  return null;
}

async function runCommand(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(args, {
    env: { ...process.env, TERM: "dumb" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    readStream(proc.stdout),
    readStream(proc.stderr),
    proc.exited,
  ]);

  return {
    stdout,
    stderr,
    exitCode,
  };
}

async function slackGet<T extends SlackApiBase>(
  token: string,
  endpoint: string,
  params: Record<string, string | undefined>
): Promise<T> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (!value) continue;
    search.set(key, value);
  }

  const response = await fetch(`https://slack.com/api/${endpoint}?${search.toString()}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Slack ${endpoint} failed with HTTP ${response.status}`);
  }

  const data = (await response.json()) as T;
  if (!data.ok) {
    throw new Error(`Slack ${endpoint} failed: ${data.error ?? "unknown_error"}`);
  }

  return data;
}

async function slackPost<T extends SlackApiBase>(
  token: string,
  endpoint: string,
  params: Record<string, string | undefined>
): Promise<T> {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (!value) continue;
    body.set(key, value);
  }

  const response = await fetch(`https://slack.com/api/${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`Slack ${endpoint} failed with HTTP ${response.status}`);
  }

  const data = (await response.json()) as T;
  if (!data.ok) {
    throw new Error(`Slack ${endpoint} failed: ${data.error ?? "unknown_error"}`);
  }

  return data;
}

function scoreSlackUserMatch(member: SlackUserMember, name: string): number {
  const target = normalizeForMatch(name);
  if (!target) return 0;

  const candidates = [
    member.profile?.display_name,
    member.real_name,
    member.profile?.real_name,
    member.name,
  ]
    .filter((value): value is string => typeof value === "string")
    .map((value) => normalizeForMatch(value))
    .filter((value) => value.length > 0);

  let best = 0;
  for (const candidate of candidates) {
    if (candidate === target) best = Math.max(best, 100);
    else if (candidate.startsWith(target) || target.startsWith(candidate)) best = Math.max(best, 80);
    else if (candidate.includes(target) || target.includes(candidate)) best = Math.max(best, 60);
  }

  return best;
}

async function findSlackUser(token: string, name: string): Promise<SlackUserSummary | null> {
  let cursor: string | undefined;
  let best: { score: number; user: SlackUserSummary } | null = null;

  for (let page = 0; page < 20; page += 1) {
    const response = await slackGet<SlackUsersListResponse>(token, "users.list", {
      limit: "200",
      ...(cursor ? { cursor } : {}),
    });

    for (const member of response.members ?? []) {
      if (member.deleted || member.is_bot) continue;
      const id = member.id?.trim();
      if (!id) continue;

      const score = scoreSlackUserMatch(member, name);
      if (score <= 0) continue;

      const user: SlackUserSummary = {
        id,
        name: member.name?.trim() || member.real_name?.trim() || member.profile?.display_name?.trim() || id,
        ...(member.real_name?.trim() ? { realName: member.real_name.trim() } : {}),
        ...(member.profile?.display_name?.trim()
          ? { displayName: member.profile.display_name.trim() }
          : {}),
        ...(member.profile?.email?.trim() ? { email: member.profile.email.trim() } : {}),
      };

      if (!best || score > best.score) {
        best = { score, user };
      }
    }

    const next = response.response_metadata?.next_cursor?.trim();
    if (!next) break;
    cursor = next;
  }

  if (!best || best.score < 60) return null;
  return best.user;
}

async function listSlackChannelsForUser(token: string, userId: string): Promise<SlackChannelSummary[]> {
  const channels: SlackChannelSummary[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;

  async function conversationHasMember(channelId: string): Promise<boolean> {
    let memberCursor: string | undefined;

    for (let page = 0; page < 30; page += 1) {
      const members = await slackGet<SlackConversationsMembersResponse>(
        token,
        "conversations.members",
        {
          channel: channelId,
          limit: "1000",
          ...(memberCursor ? { cursor: memberCursor } : {}),
        }
      );

      if ((members.members ?? []).some((memberId) => memberId === userId)) {
        return true;
      }

      const next = members.response_metadata?.next_cursor?.trim();
      if (!next) break;
      memberCursor = next;
    }

    return false;
  }

  for (let page = 0; page < 20; page += 1) {
    const response = await slackGet<SlackConversationsListResponse>(token, "conversations.list", {
      types: "public_channel,private_channel,im,mpim",
      exclude_archived: "true",
      limit: "200",
      ...(cursor ? { cursor } : {}),
    });

    for (const channel of response.channels ?? []) {
      const id = channel.id?.trim();
      if (!id || seen.has(id)) continue;
      const hasMember = await conversationHasMember(id);
      if (!hasMember) continue;
      seen.add(id);
      channels.push({
        id,
        name: channel.name?.trim() || id,
        isPrivate: Boolean(channel.is_private),
        isIm: Boolean(channel.is_im),
        isMpim: Boolean(channel.is_mpim),
      });
    }

    const next = response.response_metadata?.next_cursor?.trim();
    if (!next) break;
    cursor = next;
  }

  return channels;
}

async function fetchSlackDmHistory(
  token: string,
  userId: string
): Promise<{ dmChannelId: string | null; dmMessages: SlackMessage[] }> {
  const open = await slackPost<SlackConversationsOpenResponse>(token, "conversations.open", {
    users: userId,
    return_im: "true",
  });

  const dmChannelId = open.channel?.id?.trim() || null;
  if (!dmChannelId) {
    return {
      dmChannelId: null,
      dmMessages: [],
    };
  }

  const history = await slackGet<SlackConversationsHistoryResponse>(token, "conversations.history", {
    channel: dmChannelId,
    limit: "30",
  });

  const dmMessages = (history.messages ?? [])
    .map((message): SlackMessage | null => {
      const ts = message.ts?.trim();
      if (!ts) return null;
      return {
        ts,
        ...(message.user?.trim() ? { user: message.user.trim() } : {}),
        ...(message.text != null ? { text: trimTo(message.text, 1200) } : {}),
      };
    })
    .filter((message): message is SlackMessage => message !== null);

  return {
    dmChannelId,
    dmMessages,
  };
}

function normalizeWebsiteUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function stripHtmlTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function extractGithubUsername(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (!parsed.hostname.toLowerCase().includes("github.com")) return null;
    const first = parsed.pathname.split("/").map((part) => part.trim()).filter(Boolean)[0];
    return first || null;
  } catch {
    return trimmed.replace(/^@/, "").replace(/^github\.com\//i, "").split("/")[0]?.trim() || null;
  }
}

async function fetchGithubProfile(githubHint: string): Promise<Record<string, unknown> | null> {
  const username = extractGithubUsername(githubHint);
  if (!username) return null;

  const response = await fetch(`https://api.github.com/users/${encodeURIComponent(username)}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "joelclaw-contact-enrich",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`GitHub profile lookup failed (${response.status})`);
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const fields = [
    "login",
    "name",
    "bio",
    "company",
    "location",
    "blog",
    "email",
    "twitter_username",
    "public_repos",
    "followers",
    "following",
    "html_url",
    "created_at",
    "updated_at",
  ];

  const summary: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in payload) {
      summary[field] = payload[field];
    }
  }
  return summary;
}

async function fetchWebsiteSummary(websiteHint: string): Promise<WebSearchData["website"]> {
  const url = normalizeWebsiteUrl(websiteHint);
  if (!url) return null;

  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    headers: {
      "User-Agent": "joelclaw-contact-enrich",
      Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
    },
  });

  if (!response.ok) {
    throw new Error(`Website fetch failed (${response.status})`);
  }

  const html = await response.text();
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html);
  const descriptionMatch =
    /<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/iu.exec(html)
    || /<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["'][^>]*>/iu.exec(html);
  const headings = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/giu)]
    .map((match) => decodeHtmlEntities(stripHtmlTags(match[1] ?? "")))
    .filter((heading) => heading.length > 0)
    .slice(0, 5);

  const excerpt = decodeHtmlEntities(stripHtmlTags(html)).slice(0, 1200);

  return {
    url,
    title: titleMatch ? decodeHtmlEntities(stripHtmlTags(titleMatch[1] ?? "")) : null,
    description: descriptionMatch ? decodeHtmlEntities(stripHtmlTags(descriptionMatch[1] ?? "")) : null,
    headings,
    excerpt,
  };
}

async function embedQueryWithNomic(query: string): Promise<number[]> {
  const run = await runCommand([
    "uv",
    "run",
    "--with",
    "sentence-transformers",
    "--with",
    "torch",
    "python3",
    "-c",
    NOMIC_EMBED_SCRIPT,
    query,
  ]);

  if (run.exitCode !== 0) {
    throw new Error(`nomic embedding failed (${run.exitCode}): ${run.stderr.trim()}`);
  }

  const parsed = parseJsonFromText(run.stdout);
  if (!Array.isArray(parsed)) {
    throw new Error("nomic embedding returned non-array output");
  }

  const vector = parsed
    .map((value) => {
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string") {
        const numeric = Number.parseFloat(value);
        return Number.isFinite(numeric) ? numeric : null;
      }
      return null;
    })
    .filter((value): value is number => value !== null);

  if (vector.length !== 768) {
    throw new Error(`nomic embedding dimension mismatch: expected 768, got ${vector.length}`);
  }

  return vector;
}

async function qdrantSearchByName(name: string): Promise<MemorySearchData> {
  const vector = await embedQueryWithNomic(name);

  const response = await fetch(`${QDRANT_HOST}/collections/session_observations/points/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      vector,
      limit: 12,
      with_payload: true,
      with_vector: false,
    }),
    signal: AbortSignal.timeout(20_000),
  });

  const rawBody = await response.text();
  if (!response.ok) {
    throw new Error(`Qdrant search failed (${response.status}): ${rawBody.slice(0, 500)}`);
  }

  const payload = parseJsonFromText(rawBody) as {
    result?: Array<{
      id?: unknown;
      score?: unknown;
      payload?: unknown;
    }>;
  } | null;

  const hits = (payload?.result ?? [])
    .map((item): QdrantSearchHit | null => {
      const id = item.id != null ? String(item.id) : null;
      const score = typeof item.score === "number"
        ? item.score
        : typeof item.score === "string"
          ? Number.parseFloat(item.score)
          : Number.NaN;
      if (!id || !Number.isFinite(score)) return null;
      const sourcePayload =
        item.payload && typeof item.payload === "object"
          ? (item.payload as Record<string, unknown>)
          : {};
      const normalizedPayload: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(sourcePayload)) {
        if (typeof value === "string") normalizedPayload[key] = trimTo(value, 800);
        else normalizedPayload[key] = value;
      }
      return { id, score, payload: normalizedPayload };
    })
    .filter((item): item is QdrantSearchHit => item !== null);

  return {
    collection: "session_observations",
    model: "nomic-embed-text-v1.5",
    vectorDimensions: vector.length,
    hits,
  };
}

async function getTypesenseQueryFields(collection: string, apiKey: string): Promise<string> {
  const response = await fetch(`${TYPESENSE_HOST}/collections/${collection}`, {
    method: "GET",
    headers: {
      "X-TYPESENSE-API-KEY": apiKey,
    },
    signal: AbortSignal.timeout(8_000),
  });

  if (!response.ok) {
    throw new Error(`Typesense schema lookup failed for ${collection} (${response.status})`);
  }

  const schema = (await response.json()) as {
    fields?: Array<{ name?: unknown; type?: unknown }>;
  };

  const stringFields = (schema.fields ?? [])
    .filter((field) => field && typeof field === "object")
    .map((field) => ({
      name: typeof field.name === "string" ? field.name : "",
      type: typeof field.type === "string" ? field.type : "",
    }))
    .filter((field) => field.name.length > 0 && field.type === "string")
    .map((field) => field.name);

  const preferredOrderByCollection: Record<string, string[]> = {
    vault_notes: ["title", "content", "text", "path", "summary"],
    slack_messages: ["text", "user_name", "channel_name", "channel_category"],
  };

  const ordered: string[] = [];
  for (const field of preferredOrderByCollection[collection] ?? []) {
    if (stringFields.includes(field) && !ordered.includes(field)) {
      ordered.push(field);
    }
  }
  for (const field of stringFields) {
    if (!ordered.includes(field)) {
      ordered.push(field);
    }
  }

  if (ordered.length === 0) {
    throw new Error(`No searchable string fields found in Typesense collection ${collection}`);
  }

  return ordered.slice(0, 4).join(",");
}

function summarizeTypesenseDocument(doc: Record<string, unknown>): Record<string, unknown> {
  const keys = [
    "id",
    "title",
    "path",
    "text",
    "content",
    "user_name",
    "channel_name",
    "channel_category",
    "timestamp",
    "ingested_at",
  ];

  const summarized: Record<string, unknown> = {};
  for (const key of keys) {
    if (!(key in doc)) continue;
    const value = doc[key];
    if (typeof value === "string") summarized[key] = trimTo(value, 800);
    else summarized[key] = value;
  }
  return summarized;
}

async function searchTypesenseCollection(
  collection: string,
  query: string,
  apiKey: string
): Promise<TypesenseSearchCollection> {
  const queryBy = await getTypesenseQueryFields(collection, apiKey);
  const params = new URLSearchParams({
    q: query,
    query_by: queryBy,
    per_page: "12",
    page: "1",
  });

  const response = await fetch(
    `${TYPESENSE_HOST}/collections/${collection}/documents/search?${params.toString()}`,
    {
      method: "GET",
      headers: {
        "X-TYPESENSE-API-KEY": apiKey,
      },
      signal: AbortSignal.timeout(10_000),
    }
  );

  const rawBody = await response.text();
  if (!response.ok) {
    throw new Error(
      `Typesense search failed for ${collection} (${response.status}): ${rawBody.slice(0, 500)}`
    );
  }

  const parsed = parseJsonFromText(rawBody) as {
    found?: unknown;
    hits?: Array<{ document?: Record<string, unknown> }>;
  } | null;

  const found =
    typeof parsed?.found === "number"
      ? parsed.found
      : typeof parsed?.found === "string"
        ? Number.parseInt(parsed.found, 10)
        : 0;

  const hits = (parsed?.hits ?? [])
    .map((hit) =>
      hit && hit.document && typeof hit.document === "object"
        ? summarizeTypesenseDocument(hit.document)
        : null
    )
    .filter((hit): hit is Record<string, unknown> => hit !== null);

  return {
    collection,
    found: Number.isFinite(found) ? found : 0,
    query_by: queryBy,
    hits,
  };
}

function extractOpenRouterContent(payload: OpenRouterResponse): string {
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    const joined = content
      .map((part) => (part && typeof part.text === "string" ? part.text : ""))
      .join("")
      .trim();
    return joined;
  }
  return "";
}

function compactForPrompt(value: unknown, maxChars: number): string {
  const serialized = JSON.stringify(value, null, 2);
  return trimTo(serialized, maxChars);
}

export const contactEnrich = inngest.createFunction(
  {
    id: "contact-enrich",
    concurrency: { limit: 3 },
    retries: 2,
  },
  { event: "contact/enrich.requested" },
  async ({ event, step }) => {
    const name = event.data.name?.trim();
    if (!name) {
      throw new NonRetriableError("contact/enrich.requested requires data.name");
    }

    const depth = event.data.depth === "quick" ? "quick" : "full";
    const hints: ContactHints = event.data.hints ?? {};
    const outputPath = resolveVaultPath(name);

    const existingContact = await step.run(
      "load-existing",
      async (): Promise<StepResult<ExistingContact>> => {
        const existingPath = event.data.vault_path?.trim()
          ? resolveVaultPath(name, event.data.vault_path)
          : null;

        if (!existingPath) {
          return {
            ok: true,
            skipped: true,
            data: {
              path: null,
              markdown: null,
            },
          };
        }

        try {
          const markdown = await readFile(existingPath, "utf-8");
          return {
            ok: true,
            data: {
              path: existingPath,
              markdown,
            },
          };
        } catch (error) {
          return {
            ok: false,
            error: errorMessage(error),
            data: {
              path: existingPath,
              markdown: null,
            },
          };
        }
      }
    );

    const slackPromise = step.run("search-slack", async (): Promise<StepResult<SlackSearchData>> => {
      try {
        const token = leaseSecret("slack_user_token", "1h");
        const hintedUserId = hints.slack_user_id?.trim() || null;
        const resolvedUser =
          hintedUserId != null
            ? {
                id: hintedUserId,
                name,
              }
            : await findSlackUser(token, name);

        if (!resolvedUser) {
          return {
            ok: false,
            error: "slack_user_not_found",
            data: {
              user: null,
              channels: [],
              dmChannelId: null,
              dmMessages: [],
            },
          };
        }

        const channels = await listSlackChannelsForUser(token, resolvedUser.id);
        const dm = await fetchSlackDmHistory(token, resolvedUser.id);

        return {
          ok: true,
          data: {
            user: resolvedUser,
            channels,
            dmChannelId: dm.dmChannelId,
            dmMessages: dm.dmMessages,
          },
        };
      } catch (error) {
        return {
          ok: false,
          error: errorMessage(error),
          data: {
            user: null,
            channels: [],
            dmChannelId: null,
            dmMessages: [],
          },
        };
      }
    });

    const roamPromise = step.run("search-roam", async (): Promise<StepResult<RoamSearchData>> => {
      if (depth === "quick") {
        return {
          ok: true,
          skipped: true,
          data: {
            archivePath: ROAM_ARCHIVE_PATH,
            title_matches: [],
            block_matches: [],
          },
        };
      }

      try {
        const run = await runCommand([
          "python3",
          "-c",
          ROAM_SEARCH_SCRIPT,
          ROAM_ARCHIVE_PATH,
          name,
        ]);

        if (run.exitCode !== 0) {
          throw new Error(`python3 exited ${run.exitCode}: ${run.stderr.trim()}`);
        }

        const parsed = parseJsonFromText(run.stdout) as RoamSearchData | null;
        if (!parsed) {
          throw new Error("roam search returned non-JSON output");
        }

        return {
          ok: true,
          data: {
            archivePath: parsed.archivePath || ROAM_ARCHIVE_PATH,
            title_matches: Array.isArray(parsed.title_matches) ? parsed.title_matches : [],
            block_matches: Array.isArray(parsed.block_matches) ? parsed.block_matches : [],
          },
        };
      } catch (error) {
        return {
          ok: false,
          error: errorMessage(error),
          data: {
            archivePath: ROAM_ARCHIVE_PATH,
            title_matches: [],
            block_matches: [],
          },
        };
      }
    });

    const webPromise = step.run("search-web", async (): Promise<StepResult<WebSearchData>> => {
      if (depth === "quick") {
        return {
          ok: true,
          skipped: true,
          data: {
            github: null,
            website: null,
          },
        };
      }

      const githubHint = hints.github?.trim();
      const websiteHint = hints.website?.trim();
      if (!githubHint && !websiteHint) {
        return {
          ok: true,
          skipped: true,
          data: {
            github: null,
            website: null,
          },
        };
      }

      try {
        const [github, website] = await Promise.all([
          githubHint ? fetchGithubProfile(githubHint) : Promise.resolve(null),
          websiteHint ? fetchWebsiteSummary(websiteHint) : Promise.resolve(null),
        ]);

        return {
          ok: true,
          data: {
            github,
            website,
          },
        };
      } catch (error) {
        return {
          ok: false,
          error: errorMessage(error),
          data: {
            github: null,
            website: null,
          },
        };
      }
    });

    const granolaPromise = step.run(
      "search-granola",
      async (): Promise<StepResult<GranolaSearchData>> => {
        if (depth === "quick") {
          return {
            ok: true,
            skipped: true,
            data: {
              query: name,
              result: [],
            },
          };
        }

        try {
          let run = await runCommand(["granola", "search", name]);
          let parsed = parseJsonFromText(run.stdout);

          if (!parsed) {
            run = await runCommand(["granola", "search", name, "--json"]);
            parsed = parseJsonFromText(run.stdout);
          }

          if (run.exitCode !== 0) {
            throw new Error(`granola search failed (${run.exitCode}): ${run.stderr.trim()}`);
          }

          if (!parsed) {
            throw new Error("granola search returned non-JSON output");
          }

          return {
            ok: true,
            data: {
              query: name,
              result: parsed,
            },
          };
        } catch (error) {
          return {
            ok: false,
            error: errorMessage(error),
            data: {
              query: name,
              result: [],
            },
          };
        }
      }
    );

    const memoryPromise = step.run("search-memory", async (): Promise<StepResult<MemorySearchData>> => {
      try {
        const data = await qdrantSearchByName(name);
        return {
          ok: true,
          data,
        };
      } catch (error) {
        return {
          ok: false,
          error: errorMessage(error),
          data: {
            collection: "session_observations",
            model: "nomic-embed-text-v1.5",
            vectorDimensions: 0,
            hits: [],
          },
        };
      }
    });

    const typesensePromise = step.run(
      "search-typesense",
      async (): Promise<StepResult<TypesenseSearchData>> => {
        if (depth === "quick") {
          return {
            ok: true,
            skipped: true,
            data: {
              collections: [],
            },
          };
        }

        try {
          const apiKey = resolveTypesenseApiKey();
          const [vaultNotes, slackMessages] = await Promise.all([
            searchTypesenseCollection("vault_notes", name, apiKey),
            searchTypesenseCollection("slack_messages", name, apiKey),
          ]);

          return {
            ok: true,
            data: {
              collections: [vaultNotes, slackMessages],
            },
          };
        } catch (error) {
          return {
            ok: false,
            error: errorMessage(error),
            data: {
              collections: [],
            },
          };
        }
      }
    );

    const [slack, roam, web, granola, memory, typesense] = await Promise.all([
      slackPromise,
      roamPromise,
      webPromise,
      granolaPromise,
      memoryPromise,
      typesensePromise,
    ]);

    const synthesized = await step.run(
      "synthesize",
      async (): Promise<{ markdown: string; usage?: Record<string, unknown> }> => {
        const userPrompt = [
          `Contact name: ${name}`,
          `Depth: ${depth}`,
          `Hints:`,
          compactForPrompt(hints, 2_500),
          ``,
          `Existing contact markdown:`,
          existingContact.data.markdown ? trimTo(existingContact.data.markdown, 10_000) : "(none)",
          ``,
          `Slack search:`,
          compactForPrompt(slack, 12_000),
          ``,
          `Roam search:`,
          compactForPrompt(roam, 8_000),
          ``,
          `Web search:`,
          compactForPrompt(web, 8_000),
          ``,
          `Granola search:`,
          compactForPrompt(granola, 8_000),
          ``,
          `Memory (Qdrant) search:`,
          compactForPrompt(memory, 10_000),
          ``,
          `Typesense search:`,
          compactForPrompt(typesense, 10_000),
        ].join("\n");

        const result = await infer(userPrompt, {
          task: "summary",
          system: SYNTHESIZE_SYSTEM_PROMPT,
          component: "contact-enrich",
          action: "contact.enrich.synthesize",
          timeout: 120_000,
        });

        return {
          markdown: result.text.trim(),
          usage: result.usage,
        };
      }
    );

    const writeResult = await step.run(
      "write-vault",
      async (): Promise<{ path: string; bytes: number }> => {
        await mkdir(CONTACTS_DIR, { recursive: true });
        const markdown = synthesized.markdown.endsWith("\n")
          ? synthesized.markdown
          : `${synthesized.markdown}\n`;
        await writeFile(outputPath, markdown, "utf-8");
        return {
          path: outputPath,
          bytes: Buffer.byteLength(markdown, "utf-8"),
        };
      }
    );

    await step.run("emit-otel", async () => {
      const sourceStates = {
        load_existing: existingContact.ok ? (existingContact.skipped ? "skipped" : "ok") : "error",
        search_slack: slack.ok ? (slack.skipped ? "skipped" : "ok") : "error",
        search_roam: roam.ok ? (roam.skipped ? "skipped" : "ok") : "error",
        search_web: web.ok ? (web.skipped ? "skipped" : "ok") : "error",
        search_granola: granola.ok ? (granola.skipped ? "skipped" : "ok") : "error",
        search_memory: memory.ok ? (memory.skipped ? "skipped" : "ok") : "error",
        search_typesense: typesense.ok ? (typesense.skipped ? "skipped" : "ok") : "error",
      };
      const errorList = [
        existingContact.error,
        slack.error,
        roam.error,
        web.error,
        granola.error,
        memory.error,
        typesense.error,
      ].filter((value): value is string => typeof value === "string" && value.length > 0);

      const degraded = errorList.length > 0;
      await emitOtelEvent({
        level: degraded ? "warn" : "info",
        source: "worker",
        component: "contact-enrich",
        action: "contact.enrich.completed",
        success: !degraded,
        ...(degraded ? { error: "partial_source_failure" } : {}),
        metadata: {
          eventId: event.id,
          name,
          depth,
          outputPath: writeResult.path,
          bytesWritten: writeResult.bytes,
          sourceStates,
          sourceErrors: errorList,
          usage: synthesized.usage ?? null,
        },
      });

      return {
        emitted: true,
      };
    });

    return {
      status: "completed",
      name,
      depth,
      outputPath: writeResult.path,
      bytesWritten: writeResult.bytes,
      sourceStatus: {
        slack: slack.ok,
        roam: roam.ok,
        web: web.ok,
        granola: granola.ok,
        memory: memory.ok,
        typesense: typesense.ok,
      },
      sourceErrors: [
        slack.error,
        roam.error,
        web.error,
        granola.error,
        memory.error,
        typesense.error,
      ].filter((value): value is string => typeof value === "string" && value.length > 0),
    };
  }
);
