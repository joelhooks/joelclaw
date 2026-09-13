import { homedir } from "node:os";
import { join } from "node:path";
import type { ContactsStore } from "./contacts.ts";
import { withReadOnly } from "./sqlite-ro.ts";

export const DEFAULT_CHAT_DB = join(homedir(), "Library", "Messages", "chat.db");
/** Seconds between the Unix epoch and Apple's 2001-01-01 reference date. */
export const APPLE_EPOCH_OFFSET_S = 978_307_200;
const NS_PER_S = 1_000_000_000;
/** message.date values above this are nanoseconds; below, seconds (pre-macOS 10.13 rows). */
const NS_THRESHOLD = 1e12;
const GROUP_STYLE = 43;

export function resolveChatDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.IMSG_MCP_CHAT_DB?.trim();
  return value === undefined || value === "" ? DEFAULT_CHAT_DB : value;
}

/** Convert a Unix ms timestamp to Apple seconds since 2001-01-01. */
export function toAppleSeconds(unixMs: number): number {
  return Math.floor(unixMs / 1000) - APPLE_EPOCH_OFFSET_S;
}

/** Convert an Apple date value (ns or s scale) to an ISO timestamp. Values above 2^53 must be reduced in SQL first. */
export function appleDateToIso(value: number): string {
  const seconds = value > NS_THRESHOLD ? value / NS_PER_S : value;
  return new Date((seconds + APPLE_EPOCH_OFFSET_S) * 1000).toISOString();
}

export interface TopContactRow {
  readonly handle: string;
  readonly service: string;
  readonly person: { readonly name: string } | null;
  readonly total: number;
  readonly inbound: number;
  readonly outbound: number;
  readonly lastMessageAt: string;
  readonly chatIds: readonly number[];
}

export interface TopContactsOptions {
  readonly days: number;
  readonly limit: number;
  readonly includeGroups: boolean;
  readonly now?: number;
}

interface AggregateRow {
  handle: string;
  service: string;
  chat_id: number;
  total: number;
  outbound: number;
  last_date: number;
}

const TOP_CONTACTS_SQL = `
SELECT h.id AS handle, h.service AS service, c.ROWID AS chat_id,
       COUNT(*) AS total, SUM(m.is_from_me) AS outbound,
       MAX(CASE WHEN m.date > :nsThreshold THEN m.date / :nsPerS ELSE m.date END) AS last_date
FROM message m
JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
JOIN chat c ON c.ROWID = cmj.chat_id
JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
JOIN handle h ON h.ROWID = chj.handle_id
WHERE (m.date >= :startNs OR (m.date < :nsThreshold AND m.date >= :startS))
  AND (c.style <> :groupStyle OR :includeGroups = 1)
  AND (c.style <> :groupStyle OR m.handle_id = h.ROWID)
GROUP BY h.id, h.service, c.ROWID
`;

/**
 * Message counts per handle in the window. Direct chats attribute every message (both directions) to the
 * chat's handle. Group chats, when included, attribute inbound messages to their sender and skip outbound
 * ones (Messages stores handle_id = 0 for those).
 */
export function topContacts(dbPath: string, contacts: ContactsStore, options: TopContactsOptions): TopContactRow[] {
  const now = options.now ?? Date.now();
  const startS = toAppleSeconds(now - options.days * 86_400_000);
  const rows = withReadOnly(dbPath, "Messages database", (db) =>
    db.prepare(TOP_CONTACTS_SQL).all({
      // BigInt: ns-scale Apple dates exceed Number.MAX_SAFE_INTEGER; last_date is reduced to seconds in SQL.
      startNs: BigInt(startS) * BigInt(NS_PER_S),
      startS,
      nsThreshold: NS_THRESHOLD,
      nsPerS: NS_PER_S,
      groupStyle: GROUP_STYLE,
      includeGroups: options.includeGroups ? 1 : 0,
    }),
  ) as unknown as AggregateRow[];

  const byHandle = new Map<string, { services: Set<string>; total: number; outbound: number; last: number; chatIds: Set<number> }>();
  for (const row of rows) {
    const entry = byHandle.get(row.handle) ?? { services: new Set(), total: 0, outbound: 0, last: 0, chatIds: new Set() };
    entry.services.add(row.service);
    entry.total += row.total;
    entry.outbound += row.outbound;
    entry.last = Math.max(entry.last, row.last_date);
    entry.chatIds.add(row.chat_id);
    byHandle.set(row.handle, entry);
  }

  return [...byHandle.entries()]
    .map(([handle, entry]): TopContactRow => {
      const person = contacts.lookupHandle(handle);
      return {
        handle,
        service: [...entry.services].sort().join(","),
        person: person === null ? null : { name: person.name },
        total: entry.total,
        inbound: entry.total - entry.outbound,
        outbound: entry.outbound,
        lastMessageAt: appleDateToIso(entry.last),
        chatIds: [...entry.chatIds].sort((a, b) => a - b),
      };
    })
    .sort((a, b) => b.total - a.total || a.handle.localeCompare(b.handle))
    .slice(0, options.limit);
}
