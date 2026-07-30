import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { MemoryIdentity } from "./run-capture";

export type CaptureIdentityLookupOptions = {
  token: string;
  typesenseUrl: string;
  typesenseApiKey: string;
  machinesCollection: string;
  timeoutMs?: number;
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
};

const DEFAULT_TIMEOUT_MS = 1_000;
const MAX_MACHINE_RECORDS = 250;
const TOKEN_HASH = /^[0-9a-f]{64}$/u;

type CaptureIdentityRow = {
  machine_id: string;
  user_id: string;
  did: string | null;
};

type CaptureIdentityRecord = CaptureIdentityRow & {
  token_sha256: string;
  revoked_at: number | null;
};

export type CaptureIdentityResolverOptions = Omit<CaptureIdentityLookupOptions, "token"> & {
  databasePath: string;
};

export type CaptureIdentityResolver = {
  close: () => void;
  count: () => number;
  lookup: (token: string) => Promise<MemoryIdentity | null>;
  synchronize: () => Promise<number>;
};

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : fallback;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function machineSearchUrl(
  typesenseUrl: string,
  machinesCollection: string,
  params: URLSearchParams,
): string {
  return `${typesenseUrl}/collections/${machinesCollection}/documents/search?${params}`;
}

export async function lookupCaptureIdentity(
  options: CaptureIdentityLookupOptions,
): Promise<MemoryIdentity | null> {
  const hash = tokenHash(options.token);
  const params = new URLSearchParams({
    q: hash,
    query_by: "app_password_sha256",
    filter_by: `app_password_sha256:=\`${hash}\``,
    per_page: "1",
  });

  try {
    const response = await (options.fetchImpl ?? fetch)(
      machineSearchUrl(options.typesenseUrl, options.machinesCollection, params),
      {
        headers: { "X-TYPESENSE-API-KEY": options.typesenseApiKey },
        signal: AbortSignal.timeout(positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS)),
      },
    );
    if (!response.ok) return null;

    const data = (await response.json()) as {
      hits?: Array<{
        document: {
          id?: unknown;
          user_id?: unknown;
          did?: unknown;
          revoked_at?: unknown;
        };
      }>;
    };
    const hit = data.hits?.[0]?.document;
    if (
      !hit ||
      typeof hit.id !== "string" ||
      typeof hit.user_id !== "string" ||
      hit.revoked_at
    ) {
      return null;
    }
    return {
      user_id: hit.user_id,
      machine_id: hit.id,
      did: typeof hit.did === "string" ? hit.did : null,
    };
  } catch {
    return null;
  }
}

function parseMachineRecord(value: unknown): CaptureIdentityRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("capture auth sync received a malformed Machine record");
  }
  const document = value as Record<string, unknown>;
  if (
    typeof document.id !== "string" ||
    document.id.length === 0 ||
    typeof document.user_id !== "string" ||
    document.user_id.length === 0 ||
    typeof document.app_password_sha256 !== "string" ||
    !TOKEN_HASH.test(document.app_password_sha256)
  ) {
    throw new Error("capture auth sync received a Machine record with invalid identity fields");
  }
  if (
    document.revoked_at !== undefined &&
    (typeof document.revoked_at !== "number" || !Number.isSafeInteger(document.revoked_at))
  ) {
    throw new Error("capture auth sync received a Machine record with invalid revoked_at");
  }
  return {
    machine_id: document.id,
    user_id: document.user_id,
    did: typeof document.did === "string" ? document.did : null,
    token_sha256: document.app_password_sha256,
    revoked_at: typeof document.revoked_at === "number" ? document.revoked_at : null,
  };
}

async function fetchMachineRecords(
  options: Omit<CaptureIdentityLookupOptions, "token">,
): Promise<CaptureIdentityRecord[]> {
  const params = new URLSearchParams({
    q: "*",
    query_by: "app_password_sha256",
    per_page: String(MAX_MACHINE_RECORDS),
  });
  const response = await (options.fetchImpl ?? fetch)(
    machineSearchUrl(options.typesenseUrl, options.machinesCollection, params),
    {
      headers: { "X-TYPESENSE-API-KEY": options.typesenseApiKey },
      signal: AbortSignal.timeout(positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS)),
    },
  );
  if (!response.ok) {
    throw new Error(`capture auth sync failed with HTTP ${response.status}`);
  }
  const body = (await response.json()) as { hits?: Array<{ document?: unknown }> };
  const records = body.hits?.map((hit) => parseMachineRecord(hit.document)) ?? [];
  if (records.length === 0) {
    throw new Error("capture auth sync refused to replace the registry with zero Machine records");
  }
  return records;
}

function openRegistry(databasePath: string) {
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const database = new Database(databasePath, { create: true, strict: true });
  chmodSync(databasePath, 0o600);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA busy_timeout = 1000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS capture_identities (
      machine_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      did TEXT,
      token_sha256 TEXT NOT NULL UNIQUE,
      revoked_at INTEGER,
      synced_at INTEGER NOT NULL
    ) STRICT
  `);
  return database;
}

export function createCaptureIdentityResolver(
  options: CaptureIdentityResolverOptions,
): CaptureIdentityResolver {
  const database = openRegistry(options.databasePath);
  const findByHash = database.query(`
    SELECT machine_id, user_id, did
    FROM capture_identities
    WHERE token_sha256 = ? AND revoked_at IS NULL
    LIMIT 1
  `);
  const upsert = database.query(`
    INSERT INTO capture_identities (
      machine_id, user_id, did, token_sha256, revoked_at, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(machine_id) DO UPDATE SET
      user_id = excluded.user_id,
      did = excluded.did,
      token_sha256 = excluded.token_sha256,
      revoked_at = excluded.revoked_at,
      synced_at = excluded.synced_at
  `);

  const save = (record: CaptureIdentityRecord): void => {
    upsert.run(
      record.machine_id,
      record.user_id,
      record.did,
      record.token_sha256,
      record.revoked_at,
      Date.now(),
    );
  };

  return {
    close: () => database.close(),
    count: () =>
      (database.query("SELECT count(*) AS count FROM capture_identities").get() as {
        count: number;
      }).count,
    lookup: async (token) => {
      const hash = tokenHash(token);
      const local = findByHash.get(hash) as CaptureIdentityRow | null;
      if (local) {
        return {
          user_id: local.user_id,
          machine_id: local.machine_id,
          did: local.did,
        };
      }

      const remote = await lookupCaptureIdentity({ ...options, token });
      if (!remote) return null;
      save({
        machine_id: remote.machine_id,
        user_id: remote.user_id,
        did: remote.did,
        token_sha256: hash,
        revoked_at: null,
      });
      return remote;
    },
    synchronize: async () => {
      const records = await fetchMachineRecords(options);
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec("DELETE FROM capture_identities");
        for (const record of records) save(record);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return records.length;
    },
  };
}
