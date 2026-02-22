#!/usr/bin/env bun

/**
 * One-time cleanup for leaked tool-call XML in Typesense memory observations.
 *
 * Usage:
 *   bun run packages/system-bus/scripts/cleanup-toolcall-observations.ts
 */

import { execSync } from "node:child_process";

const TYPESENSE_URL = process.env.TYPESENSE_URL?.trim() || "http://localhost:8108";
const COLLECTION = "memory_observations";
const TARGET_PATTERNS = [
  "<toolCall>",
  "</toolCall>",
  "toolu_01",
  "<arguments>",
  "<name>bash</name>",
] as const;

const SEARCH_QUERIES = [
  "<toolCall>",
  "</toolCall>",
  "toolu_01",
  "<arguments>",
  "<name>bash</name>",
  "toolCall",
  "arguments",
  "bash",
] as const;

type JsonObject = Record<string, unknown>;

type TypesenseSearchResponse = {
  found?: number;
  hits?: Array<{
    document?: {
      id?: unknown;
      observation?: unknown;
    };
  }>;
};

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractTokenFromObject(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as JsonObject;

  const direct =
    asNonEmptyString(obj.result) ??
    asNonEmptyString(obj.value) ??
    asNonEmptyString(obj.token) ??
    asNonEmptyString(obj.secret);
  if (direct && !direct.startsWith("{") && !direct.startsWith("[")) {
    return direct;
  }

  const nested = obj.data;
  if (nested && typeof nested === "object") {
    const nestedObj = nested as JsonObject;
    const nestedToken =
      asNonEmptyString(nestedObj.result) ??
      asNonEmptyString(nestedObj.value) ??
      asNonEmptyString(nestedObj.token) ??
      asNonEmptyString(nestedObj.secret);
    if (nestedToken && !nestedToken.startsWith("{") && !nestedToken.startsWith("[")) {
      return nestedToken;
    }
  }

  return null;
}

function parseLeaseOutput(rawOutput: string): string | null {
  const output = rawOutput.trim();
  if (!output) return null;

  if (output.startsWith("{") || output.startsWith("[")) {
    try {
      const parsed = JSON.parse(output);
      return extractTokenFromObject(parsed);
    } catch {
      return null;
    }
  }

  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;

  const lastLine = lines[lines.length - 1]!;
  if (lastLine.startsWith("{") || lastLine.startsWith("[")) {
    try {
      const parsed = JSON.parse(lastLine);
      return extractTokenFromObject(parsed);
    } catch {
      return null;
    }
  }

  return lastLine;
}

function resolveTypesenseApiKey(): string {
  const envKey = process.env.TYPESENSE_API_KEY?.trim();
  if (envKey) return envKey;

  try {
    const output = execSync("secrets lease typesense_api_key --ttl 5m", {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const token = parseLeaseOutput(output);
    if (token) return token;
  } catch (error) {
    const stdout = asNonEmptyString((error as { stdout?: unknown })?.stdout) ?? "";
    const stderr = asNonEmptyString((error as { stderr?: unknown })?.stderr) ?? "";
    const merged = [stderr, stdout].filter(Boolean).join("\n");
    const token = parseLeaseOutput(merged);
    if (token) return token;
  }

  throw new Error(
    "Unable to resolve TYPESENSE_API_KEY (set env var or run `secrets lease typesense_api_key --ttl 5m`)."
  );
}

function containsLeak(observation: string): boolean {
  return TARGET_PATTERNS.some((pattern) => observation.includes(pattern));
}

function preview(observation: string): string {
  return observation.replace(/\s+/gu, " ").trim().slice(0, 100);
}

async function searchByQuery(
  query: string,
  headers: Record<string, string>
): Promise<Array<{ id: string; observation: string }>> {
  const perPage = 250;
  let page = 1;
  const results: Array<{ id: string; observation: string }> = [];

  for (;;) {
    const url = new URL(`${TYPESENSE_URL}/collections/${COLLECTION}/documents/search`);
    url.searchParams.set("q", query);
    url.searchParams.set("query_by", "observation");
    url.searchParams.set("include_fields", "id,observation");
    url.searchParams.set("per_page", String(perPage));
    url.searchParams.set("page", String(page));

    const response = await fetch(url, { headers });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Search failed for query "${query}" (${response.status}): ${body}`);
    }

    const payload = (await response.json()) as TypesenseSearchResponse;
    const hits = Array.isArray(payload.hits) ? payload.hits : [];
    if (hits.length === 0) break;

    for (const hit of hits) {
      const id = asNonEmptyString(hit.document?.id);
      const observation = asNonEmptyString(hit.document?.observation);
      if (id && observation) {
        results.push({ id, observation });
      }
    }

    if (typeof payload.found === "number" && page * perPage >= payload.found) {
      break;
    }
    page += 1;
  }

  return results;
}

async function deleteObservation(id: string, headers: Record<string, string>): Promise<boolean> {
  const url = `${TYPESENSE_URL}/collections/${COLLECTION}/documents/${encodeURIComponent(id)}`;
  const response = await fetch(url, {
    method: "DELETE",
    headers,
  });

  if (response.ok) return true;

  const body = await response.text();
  console.error(`Failed to delete ${id}: ${response.status} ${body}`);
  return false;
}

async function main() {
  const apiKey = resolveTypesenseApiKey();
  const headers = {
    "X-TYPESENSE-API-KEY": apiKey,
  };

  const matches = new Map<string, string>();

  for (const query of SEARCH_QUERIES) {
    const candidates = await searchByQuery(query, headers);
    for (const candidate of candidates) {
      if (containsLeak(candidate.observation)) {
        matches.set(candidate.id, candidate.observation);
      }
    }
  }

  const foundCount = matches.size;

  if (foundCount === 0) {
    console.log("No leaked tool-call observations found.");
    console.log("Summary: found 0, deleted 0");
    return;
  }

  for (const [id, observation] of matches.entries()) {
    console.log(`${id} | ${preview(observation)}`);
  }

  let deletedCount = 0;
  for (const id of matches.keys()) {
    const deleted = await deleteObservation(id, headers);
    if (deleted) deletedCount += 1;
  }

  console.log(`Summary: found ${foundCount}, deleted ${deletedCount}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
