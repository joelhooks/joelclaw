#!/usr/bin/env bun
/**
 * Normalize mixed seconds/milliseconds in channel and thread projections.
 *
 * Default mode is read-only. --execute updates only the timestamp fields on
 * existing document IDs, then re-exports both collections to verify no
 * seconds-scale values remain.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { normalizeChannelTimestamp } from "../packages/system-bus/src/inngest/functions/channel-message-ingest";

type ChannelDocument = {
  id: string;
  channel_type: string;
  timestamp: number;
};

type ThreadDocument = {
  id: string;
  source: string;
  first_message_at: number;
  last_message_at: number;
};

const HOME = homedir();
const args = process.argv.slice(2);
const execute = args.includes("--execute");

function arg(name: string, fallback?: string): string | undefined {
  const direct = args.find((value) => value.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function configValue(name: string): string | undefined {
  const fromProcess = process.env[name]?.trim();
  if (fromProcess) return fromProcess;
  const envPath = resolve(HOME, ".config", "system-bus.env");
  if (!existsSync(envPath)) return undefined;
  const line = readFileSync(envPath, "utf8")
    .split("\n")
    .find((candidate) => candidate.startsWith(`${name}=`));
  return line?.slice(name.length + 1).trim() || undefined;
}

const typesenseUrl = (arg("--url") ?? configValue("TYPESENSE_URL"))?.replace(/\/$/u, "");
const apiKey = configValue("TYPESENSE_API_KEY");
const receiptPath = resolve(arg("--receipt", "/tmp/channel-timestamp-normalization.json")!);
if (!typesenseUrl) throw new Error("TYPESENSE_URL is required");
if (!apiKey) throw new Error("TYPESENSE_API_KEY is required");

function isUnixSeconds(value: unknown): value is number {
  return (
    typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    && value < 100_000_000_000
  );
}

async function exportDocuments<T>(collection: string, fields: string[]): Promise<T[]> {
  const url = new URL(`${typesenseUrl}/collections/${collection}/documents/export`);
  url.searchParams.set("include_fields", fields.join(","));
  const response = await fetch(url, {
    headers: { "X-TYPESENSE-API-KEY": apiKey },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Typesense export ${collection} failed (${response.status}): ${text.slice(0, 160)}`);
  }
  return text.trim() ? text.trim().split("\n").map((line) => JSON.parse(line) as T) : [];
}

async function importUpdates(
  collection: string,
  documents: Record<string, unknown>[],
): Promise<number> {
  if (documents.length === 0) return 0;
  const url = new URL(`${typesenseUrl}/collections/${collection}/documents/import`);
  url.searchParams.set("action", "update");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      "X-TYPESENSE-API-KEY": apiKey,
    },
    body: `${documents.map((document) => JSON.stringify(document)).join("\n")}\n`,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Typesense import ${collection} failed (${response.status}): ${text.slice(0, 160)}`);
  }
  const rows = text.trim().split("\n").map((line) => JSON.parse(line) as {
    success?: boolean;
    error?: string;
  });
  const failed = rows.filter((row) => row.success !== true);
  if (failed.length > 0) {
    throw new Error(
      `Typesense import ${collection} rejected ${failed.length}/${rows.length}: ${failed[0]?.error ?? "unknown error"}`,
    );
  }
  return rows.length;
}

async function buildPlan(): Promise<{
  channelUpdates: Record<string, unknown>[];
  threadUpdates: Record<string, unknown>[];
}> {
  const channels = await exportDocuments<ChannelDocument>("channel_messages", [
    "id",
    "channel_type",
    "timestamp",
  ]);
  const threads = await exportDocuments<ThreadDocument>("conversation_threads", [
    "id",
    "source",
    "first_message_at",
    "last_message_at",
  ]);
  return {
    channelUpdates: channels
      .filter((document) => isUnixSeconds(document.timestamp))
      .map((document) => ({
        id: document.id,
        timestamp: normalizeChannelTimestamp(document.timestamp),
      })),
    threadUpdates: threads
      .filter(
        (document) =>
          isUnixSeconds(document.first_message_at)
          || isUnixSeconds(document.last_message_at),
      )
      .map((document) => ({
        id: document.id,
        ...(isUnixSeconds(document.first_message_at)
          ? { first_message_at: normalizeChannelTimestamp(document.first_message_at) }
          : {}),
        ...(isUnixSeconds(document.last_message_at)
          ? { last_message_at: normalizeChannelTimestamp(document.last_message_at) }
          : {}),
      })),
  };
}

async function main(): Promise<void> {
  const plan = await buildPlan();
  const before = {
    channelMessages: plan.channelUpdates.length,
    conversationThreads: plan.threadUpdates.length,
  };
  const updated = execute
    ? {
        channelMessages: await importUpdates("channel_messages", plan.channelUpdates),
        conversationThreads: await importUpdates("conversation_threads", plan.threadUpdates),
      }
    : { channelMessages: 0, conversationThreads: 0 };
  const remaining = execute
    ? await buildPlan()
    : plan;
  const after = {
    channelMessages: remaining.channelUpdates.length,
    conversationThreads: remaining.threadUpdates.length,
  };
  if (execute && (after.channelMessages > 0 || after.conversationThreads > 0)) {
    throw new Error(
      `timestamp verification failed: ${after.channelMessages} messages and ${after.conversationThreads} threads remain`,
    );
  }
  const receipt = {
    ok: true,
    mode: execute ? "execute" : "check",
    before,
    updated,
    after,
  };
  mkdirSync(dirname(receiptPath), { recursive: true, mode: 0o700 });
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

if (import.meta.main) await main();
