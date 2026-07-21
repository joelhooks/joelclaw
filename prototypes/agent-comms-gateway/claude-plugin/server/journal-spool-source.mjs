import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_JOURNAL_SPOOL = join(homedir(), ".joelclaw", "spool", "message-journal");
const REQUEST_EVENT_TYPES = new Set(["message.outbound.requested", "outbound.requested"]);
const CONFIRMED_EVENT_TYPES = new Set(["message.outbound.confirmed", "delivery.confirmed"]);
const FAILED_EVENT_TYPES = new Set(["message.outbound.failed", "delivery.failed"]);

async function loadRows(directory) {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  const rows = [];
  for (const name of names) {
    const raw = await readFile(join(directory, name), "utf8");
    rows.push(JSON.parse(raw));
  }
  const unique = new Map(rows.map((row) => [row.journal_event_id, row]));
  return [...unique.values()].sort((a, b) =>
    `${a.occurred_at}:${a.journal_event_id}`.localeCompare(`${b.occurred_at}:${b.journal_event_id}`));
}

// This read-only adapter implements the stream seam's future independent time-page shape.
// Replace it with readSince(recordedAt, limit, cursor) when the canonical stream exposes that API.
export async function readDayPage({ day, cursor = null, limit = 100, directory = DEFAULT_JOURNAL_SPOOL }) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) throw new Error(`Invalid day: ${day}`);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error(`Invalid limit: ${limit}`);
  const rows = (await loadRows(directory)).filter((row) => String(row.occurred_at).startsWith(day));
  const offset = cursor === null ? 0 : Number.parseInt(cursor, 10);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error(`Invalid cursor: ${cursor}`);
  const events = rows.slice(offset, offset + limit);
  const nextOffset = offset + events.length;
  return {
    events,
    nextCursor: nextOffset < rows.length ? String(nextOffset) : null,
    source: "message-journal-spool",
    sourcePath: directory,
  };
}

export async function readReplayDay({ day, directory = DEFAULT_JOURNAL_SPOOL, pageSize = 100 }) {
  const dayRows = [];
  let cursor = null;
  do {
    const page = await readDayPage({ day, cursor, limit: pageSize, directory });
    dayRows.push(...page.events);
    cursor = page.nextCursor;
  } while (cursor !== null);

  // Read all spool rows to pair requests from the selected day with later terminal receipts.
  const allRows = await loadRows(directory);
  const lifecycleByFlow = new Map();
  for (const row of allRows) {
    const flowId = row.flow_id;
    if (!flowId) continue;
    const lifecycle = lifecycleByFlow.get(flowId) ?? [];
    lifecycle.push(row);
    lifecycleByFlow.set(flowId, lifecycle);
  }

  const requests = dayRows.filter((row) => row.direction === "outbound" && REQUEST_EVENT_TYPES.has(row.event_type));
  const inputs = requests.map((request, index) => {
    const lifecycle = lifecycleByFlow.get(request.flow_id) ?? [];
    const terminal = lifecycle
      .filter((row) => row.occurred_at >= request.occurred_at)
      .filter((row) => CONFIRMED_EVENT_TYPES.has(row.event_type) || FAILED_EVENT_TYPES.has(row.event_type))
      .at(-1);
    const confirmed = terminal && CONFIRMED_EVENT_TYPES.has(terminal.event_type) ? terminal : undefined;
    const failed = terminal && FAILED_EVENT_TYPES.has(terminal.event_type) ? terminal : undefined;
    return {
      alias: `m${String(index + 1).padStart(3, "0")}`,
      inputEventId: request.journal_event_id,
      flowId: request.flow_id,
      messageKey: request.message_key,
      occurredAt: request.occurred_at,
      producer: request.producer || request.origin_system_id || "unknown",
      channel: request.channel,
      classification: request.classification || "unclassified",
      text: request.text || request.transport_text || "",
      actual: {
        deliveryState: confirmed ? "confirmed" : failed ? "failed" : "unconfirmed",
        occurredAt: terminal?.occurred_at ?? null,
        text: confirmed?.transport_text || confirmed?.text || request.transport_text || request.text || "",
        errorCode: failed?.error_code || null,
      },
    };
  });

  return {
    schemaVersion: 1,
    day,
    source: "message-journal-spool",
    sourcePath: directory,
    readContract: "readSince(recordedAt, limit, cursor)",
    inputCount: inputs.length,
    journalEventCount: dayRows.length,
    inputs,
  };
}
