import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type InboundReactionEventType,
  MessageFlowReference,
  type MessagePlatformType,
  type MessageReactionReceivedEventType,
} from "@joelclaw/message-contract";
import {
  clickHouseClientLayer,
  DEFAULT_MESSAGE_JOURNAL_OUTBOX_DIR,
  type JournalEvent,
  MessageJournalQuery,
  type MessageJournalQueryService,
  messageJournalQueryLayer,
  resolveMessageJournalConnection,
} from "@joelclaw/message-journal";
import { Effect, Layer, Schema } from "effect";

const JOURNAL_SCAN_LIMIT = 2_000;
const STATE_MATCH_WINDOW_MS = 2 * 60_000;
export const DEFAULT_NEAT_MEMORY_STATE_PATH = join(
  homedir(),
  ".joelclaw/observer-neat-memories.json",
);

export type ReactionCorrelationSource =
  | "redis-contract"
  | "redis-legacy-telegram"
  | "journal";

export interface ReactionFlowCorrelation {
  readonly flowId: string;
  readonly source: ReactionCorrelationSource;
}

export interface RedisFlowReader {
  readonly get: (key: string) => Promise<string | null>;
}

export type ReactionReceivedData = MessageReactionReceivedEventType["data"];

export type ReactionReceivedEnvelope = MessageReactionReceivedEventType & {
  readonly id: string;
};

type NeatMemoryOutcome = "worked" | "did-not-work";
type NeatMemorySentEntry = {
  readonly slug: string;
  readonly sentAt: string;
  readonly outcome: NeatMemoryOutcome | null;
  readonly [key: string]: unknown;
};
type NeatMemoryState = {
  readonly version: 1;
  readonly sent: ReadonlyArray<NeatMemorySentEntry>;
  readonly [key: string]: unknown;
};

export type NeatMemoryGradeResult =
  | {
      readonly status: "graded" | "already-graded";
      readonly flowId: string;
      readonly slug: string;
      readonly outcome: NeatMemoryOutcome;
      readonly statePath: string;
    }
  | {
      readonly status: "ignored";
      readonly flowId: string;
      readonly reason:
        | "reaction-removed"
        | "emoji-unmapped"
        | "journal-flow-unresolved"
        | "not-neat-memory"
        | "state-entry-unmatched"
        | "state-entry-ambiguous";
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseJournalRow(value: unknown): JournalEvent | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.flow_id !== "string"
    || typeof value.channel !== "string"
    || typeof value.event_type !== "string"
    || typeof value.occurred_at !== "string"
  ) {
    return undefined;
  }
  return value as unknown as JournalEvent;
}

function journalMetadata(row: JournalEvent): Record<string, unknown> {
  try {
    const parsed = JSON.parse(row.metadata_json);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function sourceValues(row: JournalEvent): ReadonlyArray<string> {
  const metadata = journalMetadata(row);
  return [
    row.producer,
    row.origin_system_id,
    row.source_ref,
    nonEmptyString(metadata.source),
    nonEmptyString(metadata.producer),
    nonEmptyString(metadata.correlationId),
    nonEmptyString(metadata.correlation_id),
    nonEmptyString(metadata.sourceEventType),
  ].filter((value): value is string => Boolean(value));
}

export function isNeatMemoryJournalRow(row: JournalEvent): boolean {
  return sourceValues(row).some(
    (value) => value === "observer/neat-memory" || value.startsWith("observer/neat-memory:"),
  );
}

function neatMemorySlugFromJournal(rows: ReadonlyArray<JournalEvent>): string | undefined {
  for (const row of rows) {
    for (const value of sourceValues(row)) {
      const match = value.match(/^observer\/neat-memory:(.+)$/u);
      if (match?.[1]) return match[1];
    }
  }
  return undefined;
}

async function readLocalJournalRows(
  predicate: (row: JournalEvent) => boolean,
  directory = DEFAULT_MESSAGE_JOURNAL_OUTBOX_DIR,
): Promise<ReadonlyArray<JournalEvent>> {
  let names: string[];
  try {
    names = (await readdir(directory))
      .filter((name) => name.endsWith(".json"))
      .sort()
      .reverse()
      .slice(0, JOURNAL_SCAN_LIMIT);
  } catch {
    return [];
  }

  const rows: JournalEvent[] = [];
  for (const name of names) {
    try {
      const row = parseJournalRow(JSON.parse(await readFile(join(directory, name), "utf8")));
      if (row && predicate(row)) rows.push(row);
    } catch {
      // One corrupt spool row must not hide every other valid journal receipt.
    }
  }
  return rows;
}

let queryPromise: Promise<MessageJournalQueryService> | undefined;

async function getJournalQuery() {
  queryPromise ??= (async () => {
    const connection = await Effect.runPromise(resolveMessageJournalConnection("reader"));
    const queryLayer = messageJournalQueryLayer(connection).pipe(
      Layer.provide(clickHouseClientLayer(connection)),
    );
    return Effect.runPromise(
      Effect.gen(function* () {
        return yield* MessageJournalQuery;
      }).pipe(Effect.provide(queryLayer)),
    );
  })();
  try {
    return await queryPromise;
  } catch (error) {
    queryPromise = undefined;
    throw error;
  }
}

export async function loadJournalRowsByFlow(
  flowId: string,
  outboxDirectory = DEFAULT_MESSAGE_JOURNAL_OUTBOX_DIR,
): Promise<ReadonlyArray<JournalEvent>> {
  const local = await readLocalJournalRows(
    (row) => row.flow_id === flowId,
    outboxDirectory,
  );
  if (local.some(isNeatMemoryJournalRow)) return local;

  try {
    const query = await getJournalQuery();
    const result = await Effect.runPromise(query.traceMessage(flowId));
    if (result.kind !== "trace") return local;
    const byId = new Map(local.map((row) => [row.journal_event_id, row]));
    for (const row of result.events) byId.set(row.journal_event_id, row);
    return [...byId.values()];
  } catch {
    return local;
  }
}

async function resolveFlowFromJournal(
  platform: MessagePlatformType,
  platformMessageId: string,
  conversationId: string,
  outboxDirectory = DEFAULT_MESSAGE_JOURNAL_OUTBOX_DIR,
): Promise<string | undefined> {
  const numericMessageId = finiteNumber(platformMessageId);
  const numericConversationId = finiteNumber(conversationId);
  const local = await readLocalJournalRows((row) => {
    if (row.channel !== platform) return false;
    if (platform === "telegram" && numericMessageId !== undefined) {
      return row.telegram_message_id === numericMessageId
        && (numericConversationId === undefined || row.telegram_chat_id === numericConversationId);
    }
    return row.message_key === `${platform}:${platformMessageId}`
      || row.message_key === `${platform}:${conversationId}:${platformMessageId}`;
  }, outboxDirectory);
  const localFlow = local.find((row) => row.delivery_state === "confirmed")?.flow_id
    ?? local[0]?.flow_id;
  if (localFlow) return localFlow;

  if (platform !== "telegram" || numericMessageId === undefined) return undefined;
  try {
    const query = await getJournalQuery();
    const result = await Effect.runPromise(query.traceMessage({
      lookup: platformMessageId,
      ...(numericConversationId === undefined ? {} : { telegramChatId: numericConversationId }),
    }));
    return result.kind === "trace" ? result.flowId : undefined;
  } catch {
    return undefined;
  }
}

export async function resolveReactionFlow(
  event: InboundReactionEventType,
  redis: RedisFlowReader,
  options: { readonly outboxDirectory?: string } = {},
): Promise<ReactionFlowCorrelation | undefined> {
  const platformMessageId = event.platformIds.messageId;
  if (!platformMessageId) return undefined;

  const contractKeys = [
    `joelclaw:message-contract:message:${event.platform}:${platformMessageId}`,
    `joelclaw:message-contract:message:${event.platform}:${event.platformIds.conversationId}:${platformMessageId}`,
  ];
  for (const key of contractKeys) {
    try {
      const flowId = nonEmptyString(await redis.get(key));
      if (flowId) return { flowId, source: "redis-contract" };
    } catch {
      break;
    }
  }

  if (event.platform === "telegram") {
    try {
      const flowId = nonEmptyString(await redis.get(
        `joelclaw:message-journal:telegram-flow:${event.platformIds.conversationId}:${platformMessageId}`,
      ));
      if (flowId) return { flowId, source: "redis-legacy-telegram" };
    } catch {
      // Continue to the durable journal fallback.
    }
  }

  const flowId = await resolveFlowFromJournal(
    event.platform,
    platformMessageId,
    event.platformIds.conversationId,
    options.outboxDirectory,
  );
  return flowId ? { flowId, source: "journal" } : undefined;
}

export function isAuthorizedJoelReaction(event: InboundReactionEventType): boolean {
  return event.authorization.verdict === "accepted"
    && event.authorization.reason === "authorized_joel"
    && event.authorization.actualActorId === event.authorization.expectedActorId
    && event.actor.platformUserId === event.authorization.expectedActorId;
}

export function buildReactionReceivedEnvelope(
  event: InboundReactionEventType,
  correlation: ReactionFlowCorrelation,
): ReactionReceivedEnvelope {
  const rawEventId = event.audit.rawEventId ?? event.rawAnchors.transportEventId ?? event.eventId;
  const platformMessageId = event.platformIds.messageId ?? event.rawAnchors.sourceMessageId;
  if (!platformMessageId) throw new Error("Inbound reaction has no source platform message id");
  const displayName = event.actor.displayName ?? event.actor.userName ?? undefined;
  const emoji = event.rawEmoji.trim() || event.emoji.trim();
  if (!emoji) throw new Error("Inbound reaction has no emoji");

  return {
    id: `${event.eventId}:flow:${correlation.flowId}`,
    name: "message/reaction.received",
    data: {
      contractVersion: 2,
      flowId: Schema.decodeUnknownSync(MessageFlowReference)(correlation.flowId),
      platform: event.platform,
      actor: {
        id: event.actor.platformUserId,
        ...(displayName ? { displayName } : {}),
      },
      emoji,
      action: event.added ? "added" : "removed",
      added: event.added,
      at: event.occurredAt,
      rawEventId,
      platformMessageId,
      correlationSource: correlation.source,
    },
  };
}

export function mapReactionOutcome(emoji: string): NeatMemoryOutcome | undefined {
  const normalized = emoji.replaceAll("\uFE0F", "").trim().toLowerCase();
  if (["👍", "❤", "🔥", "💯", "+1", "thumbsup", "thumbs-up", "heart", "fire", "100"].includes(normalized)) {
    return "worked";
  }
  if (["👎", "💩", "-1", "thumbsdown", "thumbs-down", "poop", "shit"].includes(normalized)) {
    return "did-not-work";
  }
  return undefined;
}

function decodeNeatMemoryState(value: unknown): NeatMemoryState {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.sent)) {
    throw new Error("Neat-memory state is malformed");
  }
  const sent = value.sent.map((entry) => {
    if (
      !isRecord(entry)
      || !nonEmptyString(entry.slug)
      || !nonEmptyString(entry.sentAt)
    ) {
      throw new Error("Neat-memory state contains a malformed sent entry");
    }
    if (!Number.isFinite(Date.parse(entry.sentAt as string))) {
      throw new Error("Neat-memory state contains an invalid sentAt timestamp");
    }
    const outcome = entry.outcome === "worked" || entry.outcome === "did-not-work"
      ? entry.outcome
      : null;
    return { ...entry, outcome } as NeatMemorySentEntry;
  });
  return { ...value, version: 1, sent } as NeatMemoryState;
}

function journalTimestamp(row: JournalEvent): number | undefined {
  const iso = row.occurred_at.includes("T")
    ? row.occurred_at
    : `${row.occurred_at.replace(" ", "T")}Z`;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : undefined;
}

type StateEntryMatch =
  | { readonly status: "matched"; readonly index: number }
  | { readonly status: "unmatched" | "ambiguous" };

function findStateEntry(
  state: NeatMemoryState,
  rows: ReadonlyArray<JournalEvent>,
  flowId: string,
): StateEntryMatch {
  const flowMatch = state.sent.findIndex((entry) => entry.flowId === flowId);
  if (flowMatch >= 0) return { status: "matched", index: flowMatch };

  const explicitSlug = neatMemorySlugFromJournal(rows);
  if (explicitSlug) {
    const exact = state.sent.findIndex((entry) => entry.slug === explicitSlug);
    if (exact >= 0) return { status: "matched", index: exact };
  }

  const sentAt = rows
    .filter(isNeatMemoryJournalRow)
    .map(journalTimestamp)
    .filter((value): value is number => value !== undefined)
    .sort((a, b) => b - a)[0];
  if (sentAt === undefined) return { status: "unmatched" };

  const candidates = state.sent.flatMap((entry, index) => {
    const distance = Math.abs(Date.parse(entry.sentAt) - sentAt);
    return distance <= STATE_MATCH_WINDOW_MS ? [{ index, distance }] : [];
  }).sort((a, b) => a.distance - b.distance);
  if (candidates.length === 0) return { status: "unmatched" };
  if (candidates.length > 1) return { status: "ambiguous" };
  const candidate = candidates[0];
  return candidate
    ? { status: "matched", index: candidate.index }
    : { status: "unmatched" };
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await chmod(temp, 0o600);
    await rename(temp, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function gradeNeatMemoryReaction(
  reaction: ReactionReceivedData,
  options: {
    readonly statePath?: string;
    readonly loadJournalRows?: (flowId: string) => Promise<ReadonlyArray<JournalEvent>>;
  } = {},
): Promise<NeatMemoryGradeResult> {
  if (reaction.action !== "added") {
    return { status: "ignored", flowId: reaction.flowId, reason: "reaction-removed" };
  }
  const outcome = mapReactionOutcome(reaction.emoji);
  if (!outcome) {
    return { status: "ignored", flowId: reaction.flowId, reason: "emoji-unmapped" };
  }

  const rows = await (options.loadJournalRows ?? loadJournalRowsByFlow)(reaction.flowId);
  if (rows.length === 0) {
    return { status: "ignored", flowId: reaction.flowId, reason: "journal-flow-unresolved" };
  }
  if (!rows.some(isNeatMemoryJournalRow)) {
    return { status: "ignored", flowId: reaction.flowId, reason: "not-neat-memory" };
  }

  const statePath = options.statePath ?? DEFAULT_NEAT_MEMORY_STATE_PATH;
  const initialState = decodeNeatMemoryState(JSON.parse(await readFile(statePath, "utf8")));
  const initialMatch = findStateEntry(initialState, rows, reaction.flowId);
  if (initialMatch.status !== "matched") {
    return {
      status: "ignored",
      flowId: reaction.flowId,
      reason: initialMatch.status === "ambiguous"
        ? "state-entry-ambiguous"
        : "state-entry-unmatched",
    };
  }
  const initialEntry = initialState.sent[initialMatch.index];
  if (!initialEntry) {
    return { status: "ignored", flowId: reaction.flowId, reason: "state-entry-unmatched" };
  }

  // Re-read immediately before the replacement so an observer append that
  // landed during journal lookup is merged instead of silently discarded.
  const state = decodeNeatMemoryState(JSON.parse(await readFile(statePath, "utf8")));
  const entryIndex = state.sent.findIndex((entry) => entry.slug === initialEntry.slug);
  const entry = entryIndex >= 0 ? state.sent[entryIndex] : undefined;
  if (!entry) {
    return { status: "ignored", flowId: reaction.flowId, reason: "state-entry-unmatched" };
  }
  if (entry.outcome === outcome) {
    return {
      status: "already-graded",
      flowId: reaction.flowId,
      slug: entry.slug,
      outcome,
      statePath,
    };
  }

  const sent = [...state.sent];
  sent[entryIndex] = { ...entry, outcome };
  await writeJsonAtomic(statePath, { ...state, sent });
  return {
    status: "graded",
    flowId: reaction.flowId,
    slug: entry.slug,
    outcome,
    statePath,
  };
}

export const __messageReactionTestUtils = {
  resetJournalQuery(): void {
    queryPromise = undefined;
  },
};
