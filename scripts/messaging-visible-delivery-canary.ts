#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const JOURNAL_OUTBOX = join(homedir(), ".joelclaw", "spool", "message-journal");

type JsonRecord = Record<string, unknown>;

export interface VisibleDeliveryReceipt {
  readonly eventId: string;
  readonly flowId: string;
  readonly platformMessageId: string;
  readonly telegramChatId: number;
  readonly telegramMessageId: number;
  readonly journalEventId: string;
  readonly journalSource: "clickhouse" | "outbox";
}

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseMetadata(value: unknown): JsonRecord {
  if (typeof value === "string") {
    try {
      return record(JSON.parse(value)) ?? {};
    } catch {
      return {};
    }
  }
  return record(value) ?? {};
}

export function verifyJournalRow(
  value: unknown,
  eventId: string,
  journalSource: VisibleDeliveryReceipt["journalSource"],
): VisibleDeliveryReceipt | undefined {
  const row = record(value);
  if (!row) return undefined;

  const source = record(row.source);
  const delivery = record(row.delivery);
  const telegram = record(row.telegram);
  const metadata = parseMetadata(row.metadata ?? row.metadata_json);
  const originSystemId = nonEmptyString(
    row.origin_system_id ?? source?.originSystemId,
  );
  if (originSystemId !== eventId) return undefined;

  const eventType = nonEmptyString(row.event_type ?? row.eventType);
  const deliveryState = nonEmptyString(
    row.delivery_state ?? delivery?.state,
  );
  if (
    eventType !== "message.outbound.confirmed" ||
    deliveryState !== "confirmed"
  ) {
    return undefined;
  }

  const producer = nonEmptyString(row.producer ?? source?.producer);
  if (producer !== "chat-sdk-outbound-v1") return undefined;

  const flowId = nonEmptyString(row.flow_id ?? row.flowId);
  const journalEventId = nonEmptyString(
    row.journal_event_id ?? row.journalEventId,
  );
  const telegramChatId = finiteInteger(
    row.telegram_chat_id ?? telegram?.chatId,
  );
  const telegramMessageId = finiteInteger(
    row.telegram_message_id ?? telegram?.messageId,
  );
  const platformMessageId = nonEmptyString(metadata.platformMessageId);
  if (
    !flowId ||
    !journalEventId ||
    telegramChatId === undefined ||
    telegramMessageId === undefined ||
    !platformMessageId
  ) {
    return undefined;
  }

  if (platformMessageId !== `${telegramChatId}:${telegramMessageId}`) {
    return undefined;
  }

  return {
    eventId,
    flowId,
    platformMessageId,
    telegramChatId,
    telegramMessageId,
    journalEventId,
    journalSource,
  };
}

export async function runJson(
  command: string[],
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
): Promise<JsonRecord> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  const terminateTimer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGTERM");
    } catch {
      // The child may have exited while the timeout callback was queued.
    }
    forceKillTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The SIGTERM path already finished.
      }
    }, 1_000);
  }, timeoutMs);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]).finally(() => {
    clearTimeout(terminateTimer);
    if (forceKillTimer) clearTimeout(forceKillTimer);
  });
  if (timedOut) {
    throw new Error(`${command.join(" ")} timed out after ${timeoutMs}ms`);
  }
  if (exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} exited ${exitCode}: ${stderr.trim() || stdout.trim()}`,
    );
  }
  const parsed = record(JSON.parse(stdout));
  if (!parsed) throw new Error(`${command[0]} returned a non-object envelope`);
  return parsed;
}

function notifyEventId(envelope: JsonRecord): string {
  if (envelope.ok !== true) {
    throw new Error(`notify send failed: ${JSON.stringify(envelope.error ?? envelope)}`);
  }
  const result = record(envelope.result);
  const eventId = nonEmptyString(result?.eventId);
  if (!eventId) throw new Error("notify send returned no eventId");
  return eventId;
}

async function readClickHouse(eventId: string): Promise<VisibleDeliveryReceipt | undefined> {
  let envelope: JsonRecord;
  try {
    envelope = await runJson([
      "joelclaw",
      "messages",
      "audit",
      "--since",
      "5m",
      "--channel",
      "telegram",
      "--direction",
      "outbound",
      "--limit",
      "1000",
    ]);
  } catch {
    return undefined;
  }
  if (envelope.ok !== true) return undefined;
  const events = record(envelope.result)?.events;
  if (!Array.isArray(events)) return undefined;
  for (const event of events) {
    const receipt = verifyJournalRow(event, eventId, "clickhouse");
    if (receipt) return receipt;
  }
  return undefined;
}

async function readOutbox(
  eventId: string,
  startedAtMs: number,
): Promise<VisibleDeliveryReceipt | undefined> {
  let names: string[];
  try {
    names = await readdir(JOURNAL_OUTBOX);
  } catch {
    return undefined;
  }
  for (const name of names.filter((candidate) => candidate.endsWith(".json"))) {
    const path = join(JOURNAL_OUTBOX, name);
    try {
      const info = await stat(path);
      if (info.mtimeMs < startedAtMs - 1_000) continue;
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      const receipt = verifyJournalRow(value, eventId, "outbox");
      if (receipt) return receipt;
    } catch {
      // A concurrent outbox replay may move a file between readdir and read.
    }
  }
  return undefined;
}

export async function runVisibleDeliveryCanary(
  timeoutMs = Number(process.env.ACTING_CANARY_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
): Promise<VisibleDeliveryReceipt> {
  const sendStartedAtMs = Date.now();
  const canaryId = randomUUID();
  const envelope = await runJson([
    "joelclaw",
    "notify",
    "send",
    `Chat SDK visible-delivery canary ${canaryId}`,
    "--priority",
    "urgent",
    "--telegram-only",
    "--source",
    "cutover-visible-delivery-canary",
  ]);
  const eventId = notifyEventId(envelope);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const receipt =
      (await readClickHouse(eventId)) ??
      (await readOutbox(eventId, sendStartedAtMs));
    if (receipt) return receipt;
    await Bun.sleep(500);
  }

  throw new Error(
    `visible-delivery canary failed: event ${eventId} produced no fresh Chat SDK confirmed journal row with a matching Telegram platform message id within ${timeoutMs}ms`,
  );
}

if (import.meta.main) {
  try {
    const receipt = await runVisibleDeliveryCanary();
    console.log(JSON.stringify({ ok: true, receipt }, null, 2));
  } catch (error) {
    console.error(
      JSON.stringify(
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  }
}
