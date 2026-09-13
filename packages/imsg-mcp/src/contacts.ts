import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { withReadOnly } from "./sqlite-ro.ts";

export const CONTACTS_CACHE_TTL_MS = 5 * 60_000;
const ADDRESSBOOK_FILE = "AddressBook-v22.abcddb";

export interface Person {
  readonly name: string;
  readonly first: string | null;
  readonly last: string | null;
  readonly nickname: string | null;
  readonly organization: string | null;
  readonly phones: readonly string[];
  readonly emails: readonly string[];
}

export interface ContactsIndex {
  readonly people: readonly Person[];
  /** normalized handle (E.164 phone or lowercase email) -> person */
  readonly byHandle: ReadonlyMap<string, Person>;
  readonly sources: readonly string[];
  readonly errors: readonly string[];
  readonly builtAt: number;
}

export interface ContactsStore {
  lookupHandle(handle: string): Person | null;
  searchPeople(query: string, limit?: number): Person[];
  status(): { readonly sources: number; readonly people: number; readonly errors: readonly string[]; readonly builtAt: string };
  refresh(): ContactsIndex;
}

export interface ContactsOptions {
  /** Explicit AddressBook database paths; default discovers under ~/Library/Application Support/AddressBook. */
  readonly paths?: readonly string[];
  readonly ttlMs?: number;
  readonly now?: () => number;
}

/** Default AddressBook databases: every Sources/<id>/ store plus the top-level store when present. */
export function defaultAddressBookPaths(home: string = homedir()): string[] {
  const root = join(home, "Library", "Application Support", "AddressBook");
  const paths: string[] = [];
  const top = join(root, ADDRESSBOOK_FILE);
  if (existsSync(top)) paths.push(top);
  let sources: string[] = [];
  try {
    sources = readdirSync(join(root, "Sources"));
  } catch {
    sources = [];
  }
  for (const id of sources.sort()) {
    const candidate = join(root, "Sources", id, ADDRESSBOOK_FILE);
    if (existsSync(candidate)) paths.push(candidate);
  }
  return paths;
}

/**
 * Normalize a phone number to E.164 (default country US). Returns null when the input has no digits.
 * Short codes (fewer than 7 digits) are returned as bare digits.
 */
export function normalizePhone(raw: string): string | null {
  let value = raw.trim().replace(/^tel:/iu, "");
  value = value.replace(/\s*(?:x|ext\.?|extension|;).*$/iu, "");
  const plus = value.startsWith("+");
  const digits = value.replace(/\D/gu, "");
  if (digits === "") return null;
  if (plus) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length < 7) return digits;
  return `+${digits}`;
}

export function normalizeEmail(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  return value === "" ? null : value;
}

/** Normalize any iMessage handle: emails lowercase, everything else as E.164 phone. */
export function normalizeHandle(handle: string): string | null {
  return handle.includes("@") ? normalizeEmail(handle) : normalizePhone(handle);
}

interface RecordRow {
  Z_PK: number;
  ZFIRSTNAME: string | null;
  ZLASTNAME: string | null;
  ZORGANIZATION: string | null;
  ZNICKNAME: string | null;
}

interface HandleRow {
  ZOWNER: number;
  value: string | null;
}

interface MutablePerson {
  first: string | null;
  last: string | null;
  nickname: string | null;
  organization: string | null;
  phones: Set<string>;
  emails: Set<string>;
}

const clean = (value: string | null): string | null => {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

export function displayName(p: { first: string | null; last: string | null; nickname: string | null; organization: string | null }): string {
  const full = [p.first, p.last].filter((v): v is string => v !== null).join(" ");
  if (full !== "") return full;
  if (p.nickname !== null) return p.nickname;
  if (p.organization !== null) return p.organization;
  return "";
}

function readSource(path: string, people: MutablePerson[], byHandle: Map<string, MutablePerson>): void {
  withReadOnly(path, "AddressBook database", (db) => {
    const records = db
      .prepare("SELECT Z_PK, ZFIRSTNAME, ZLASTNAME, ZORGANIZATION, ZNICKNAME FROM ZABCDRECORD")
      .all() as unknown as RecordRow[];
    const phones = db.prepare("SELECT ZOWNER, ZFULLNUMBER AS value FROM ZABCDPHONENUMBER").all() as unknown as HandleRow[];
    const emails = db.prepare("SELECT ZOWNER, ZADDRESS AS value FROM ZABCDEMAILADDRESS").all() as unknown as HandleRow[];

    const phonesByOwner = new Map<number, string[]>();
    for (const row of phones) {
      const normalized = row.value === null ? null : normalizePhone(row.value);
      if (normalized === null) continue;
      phonesByOwner.set(row.ZOWNER, [...(phonesByOwner.get(row.ZOWNER) ?? []), normalized]);
    }
    const emailsByOwner = new Map<number, string[]>();
    for (const row of emails) {
      const normalized = row.value === null ? null : normalizeEmail(row.value);
      if (normalized === null) continue;
      emailsByOwner.set(row.ZOWNER, [...(emailsByOwner.get(row.ZOWNER) ?? []), normalized]);
    }

    for (const record of records) {
      const recordPhones = phonesByOwner.get(record.Z_PK) ?? [];
      const recordEmails = emailsByOwner.get(record.Z_PK) ?? [];
      const first = clean(record.ZFIRSTNAME);
      const last = clean(record.ZLASTNAME);
      const nickname = clean(record.ZNICKNAME);
      const organization = clean(record.ZORGANIZATION);
      if (recordPhones.length === 0 && recordEmails.length === 0) continue;
      if (first === null && last === null && nickname === null && organization === null) continue;

      // Merge with an existing person that already owns one of these handles (same contact in several sources).
      let person = [...recordPhones, ...recordEmails].map((h) => byHandle.get(h)).find((p) => p !== undefined);
      if (person === undefined) {
        person = { first, last, nickname, organization, phones: new Set(), emails: new Set() };
        people.push(person);
      } else {
        person.first ??= first;
        person.last ??= last;
        person.nickname ??= nickname;
        person.organization ??= organization;
      }
      for (const phone of recordPhones) {
        person.phones.add(phone);
        byHandle.set(phone, person);
      }
      for (const email of recordEmails) {
        person.emails.add(email);
        byHandle.set(email, person);
      }
    }
  });
}

export function buildContactsIndex(paths: readonly string[], now: number = Date.now()): ContactsIndex {
  const drafts: MutablePerson[] = [];
  const draftByHandle = new Map<string, MutablePerson>();
  const sources: string[] = [];
  const errors: string[] = [];
  if (paths.length === 0) {
    errors.push("no AddressBook databases found (Sources/*/AddressBook-v22.abcddb); is Full Disk Access granted?");
  }
  for (const path of paths) {
    try {
      readSource(path, drafts, draftByHandle);
      sources.push(path);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  const frozen = new Map<MutablePerson, Person>();
  const people = drafts.map((draft) => {
    const person: Person = {
      name: displayName(draft),
      first: draft.first,
      last: draft.last,
      nickname: draft.nickname,
      organization: draft.organization,
      phones: [...draft.phones],
      emails: [...draft.emails],
    };
    frozen.set(draft, person);
    return person;
  });
  const byHandle = new Map<string, Person>();
  for (const [handle, draft] of draftByHandle) byHandle.set(handle, frozen.get(draft) as Person);
  return { people, byHandle, sources, errors, builtAt: now };
}

export function createContactsStore(options: ContactsOptions = {}): ContactsStore {
  const ttl = options.ttlMs ?? CONTACTS_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  let cached: ContactsIndex | null = null;

  const index = (): ContactsIndex => {
    const current = now();
    if (cached === null || current - cached.builtAt >= ttl) {
      cached = buildContactsIndex(options.paths ?? defaultAddressBookPaths(), current);
    }
    return cached;
  };

  return {
    refresh: () => {
      cached = buildContactsIndex(options.paths ?? defaultAddressBookPaths(), now());
      return cached;
    },
    lookupHandle: (handle) => {
      const normalized = normalizeHandle(handle);
      if (normalized === null) return null;
      return index().byHandle.get(normalized) ?? null;
    },
    searchPeople: (query, limit = 10) => {
      const needle = query.trim().toLowerCase();
      if (needle === "") return [];
      const { people, byHandle } = index();
      const results: Person[] = [];
      const seen = new Set<Person>();
      const normalized = normalizeHandle(query);
      const exact = normalized === null ? undefined : byHandle.get(normalized);
      if (exact !== undefined) {
        results.push(exact);
        seen.add(exact);
      }
      for (const person of people) {
        if (results.length >= limit) break;
        if (seen.has(person)) continue;
        const haystack = [person.name, person.first, person.last, person.nickname, person.organization]
          .filter((v): v is string => v !== null)
          .join("\n")
          .toLowerCase();
        if (haystack.includes(needle)) {
          results.push(person);
          seen.add(person);
        }
      }
      return results.slice(0, limit);
    },
    status: () => {
      const current = index();
      return {
        sources: current.sources.length,
        people: current.people.length,
        errors: current.errors,
        builtAt: new Date(current.builtAt).toISOString(),
      };
    },
  };
}
