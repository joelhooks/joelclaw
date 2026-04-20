import { execSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { respond, respondError } from "../response"

const PDS_URL = (process.env.PDS_URL ?? "http://localhost:9627").replace(/\/$/, "")
const DEFAULT_PDS_HANDLE = process.env.PDS_JOEL_HANDLE ?? "joel.pds.panda.tail7af24.ts.net"
const SESSION_CACHE_PATH = process.env.PDS_SESSION_PATH ?? join(homedir(), ".joelclaw", "pds-session.json")
const SESSION_MAX_AGE_MS = 90 * 60 * 1000
const REQUEST_TIMEOUT_MS = 5_000

type PdsSession = {
  accessJwt: string
  refreshJwt: string
  did: string
  handle: string
  createdAt: number
}

type LeaseResponse = {
  ok?: unknown
  success?: unknown
  value?: unknown
  result?: unknown
  token?: unknown
  secret?: unknown
  data?: unknown
  error?: unknown
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.startsWith("{") || trimmed.startsWith("[")
}

function unwrapLeaseValue(parsed: LeaseResponse): string | null {
  const direct = asString(parsed.value)
    ?? asString(parsed.result)
    ?? asString(parsed.token)
    ?? asString(parsed.secret)
  if (direct && !looksLikeJson(direct)) return direct

  const resultRecord = asRecord(parsed.result)
  if (resultRecord) {
    const nested = asString(resultRecord.value)
      ?? asString(resultRecord.result)
      ?? asString(resultRecord.token)
      ?? asString(resultRecord.secret)
    if (nested && !looksLikeJson(nested)) return nested
  }

  const dataRecord = asRecord(parsed.data)
  if (dataRecord) {
    const nested = asString(dataRecord.value)
      ?? asString(dataRecord.result)
      ?? asString(dataRecord.token)
      ?? asString(dataRecord.secret)
    if (nested && !looksLikeJson(nested)) return nested
  }

  return null
}

function parseLeaseOutput(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ""

  if (!looksLikeJson(trimmed)) {
    return trimmed
  }

  try {
    const parsed = JSON.parse(trimmed) as LeaseResponse
    if (parsed.ok === false || parsed.success === false) {
      return ""
    }
    return unwrapLeaseValue(parsed) ?? ""
  } catch {
    return trimmed
  }
}

function leaseSecret(name: string, ttl = "1h"): string {
  try {
    const output = execSync(`secrets lease ${name} --ttl ${ttl}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10_000,
    })
    return parseLeaseOutput(output)
  } catch (error) {
    const stdout = typeof error === "object" && error && "stdout" in error ? String((error as { stdout?: unknown }).stdout ?? "") : ""
    const stderr = typeof error === "object" && error && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : ""
    return parseLeaseOutput(`${stderr}\n${stdout}`)
  }
}

async function fetchJson(pathname: string, init?: RequestInit): Promise<{ ok: boolean; status: number; text: string; json: any }> {
  const res = await fetch(`${PDS_URL}${pathname}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await res.text()
  let json: any = null
  try {
    json = text.length > 0 ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { ok: res.ok, status: res.status, text, json }
}

async function resolveDescribeRepo(repo: string): Promise<any | null> {
  const response = await fetchJson(`/xrpc/com.atproto.repo.describeRepo?repo=${encodeURIComponent(repo)}`)
  return response.ok ? response.json : null
}

async function resolveSessionIdentifier(did: string): Promise<string> {
  const explicit = process.env.PDS_JOEL_IDENTIFIER?.trim()
    || process.env.PDS_JOEL_HANDLE?.trim()
    || leaseSecret("pds_joel_handle")
  if (explicit) return explicit

  const described = await resolveDescribeRepo(did)
  const handle = asString(described?.handle)
  if (handle) return handle

  return DEFAULT_PDS_HANDLE || did
}

async function describeCurrentRepo(repo: string): Promise<any | null> {
  const identifier = await resolveSessionIdentifier(repo)
  const describedByRepo = await resolveDescribeRepo(repo)
  if (describedByRepo) return describedByRepo
  if (identifier !== repo) {
    return await resolveDescribeRepo(identifier)
  }
  return null
}

async function getCredentials(): Promise<{ did: string; password: string; identifier: string }> {
  const did = process.env.PDS_JOEL_DID?.trim() || leaseSecret("pds_joel_did")
  const password = process.env.PDS_JOEL_PASSWORD?.trim() || leaseSecret("pds_joel_password")

  if (!did || !password) {
    throw new Error("PDS credentials unavailable (pds_joel_did / pds_joel_password)")
  }

  return {
    did,
    password,
    identifier: await resolveSessionIdentifier(did),
  }
}

async function readCachedSession(): Promise<PdsSession | null> {
  try {
    if (!existsSync(SESSION_CACHE_PATH)) return null
    const raw = await readFile(SESSION_CACHE_PATH, "utf-8")
    const parsed = JSON.parse(raw) as Partial<PdsSession>
    if (
      typeof parsed.accessJwt !== "string"
      || typeof parsed.refreshJwt !== "string"
      || typeof parsed.did !== "string"
      || typeof parsed.handle !== "string"
      || typeof parsed.createdAt !== "number"
    ) {
      return null
    }
    return parsed as PdsSession
  } catch {
    return null
  }
}

async function writeCachedSession(session: PdsSession): Promise<void> {
  await mkdir(dirname(SESSION_CACHE_PATH), { recursive: true })
  await writeFile(SESSION_CACHE_PATH, `${JSON.stringify(session, null, 2)}\n`, "utf-8")
}

function isFresh(session: PdsSession): boolean {
  return Date.now() - session.createdAt < SESSION_MAX_AGE_MS
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const [, payload] = token.split(".")
    if (!payload) return null
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/")
    const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4))
    return JSON.parse(Buffer.from(`${normalized}${pad}`, "base64").toString("utf-8")) as Record<string, unknown>
  } catch {
    return null
  }
}

function tokenSummary(token: string): { present: boolean; length: number; expiresAt?: string } {
  const payload = decodeJwtPayload(token)
  const exp = typeof payload?.exp === "number" ? new Date(payload.exp * 1000).toISOString() : undefined
  return {
    present: token.length > 0,
    length: token.length,
    ...(exp ? { expiresAt: exp } : {}),
  }
}

async function getSession(forceRefresh = false): Promise<{ session: PdsSession; cache: "fresh" | "refreshed" }> {
  if (!forceRefresh) {
    const cached = await readCachedSession()
    if (cached && isFresh(cached)) {
      return { session: cached, cache: "fresh" }
    }
  }

  const { identifier, password } = await getCredentials()
  const response = await fetchJson("/xrpc/com.atproto.server.createSession", {
    method: "POST",
    body: JSON.stringify({ identifier, password }),
  })

  if (!response.ok) {
    throw new Error(`PDS createSession failed (${response.status}): ${response.text}`)
  }

  const data = response.json as {
    accessJwt: string
    refreshJwt: string
    did: string
    handle: string
  }

  const session: PdsSession = {
    ...data,
    createdAt: Date.now(),
  }
  await writeCachedSession(session)
  return { session, cache: "refreshed" }
}

async function authHeaders(forceRefresh = false): Promise<{ headers: HeadersInit; session: PdsSession; cache: "fresh" | "refreshed" }> {
  const { session, cache } = await getSession(forceRefresh)
  return {
    session,
    cache,
    headers: {
      Authorization: `Bearer ${session.accessJwt}`,
    },
  }
}

const rootCmd = Command.make("pds", {}, () =>
  Effect.gen(function* () {
    const currentDid = process.env.PDS_JOEL_DID?.trim() || leaseSecret("pds_joel_did") || undefined
    const currentHandle = currentDid
      ? yield* Effect.promise(() => resolveSessionIdentifier(currentDid))
      : DEFAULT_PDS_HANDLE

    yield* Console.log(
      respond(
        "pds",
        {
          url: PDS_URL,
          sessionCachePath: SESSION_CACHE_PATH,
          repo: {
            did: currentDid,
            handle: currentHandle,
          },
          commands: ["health", "describe", "collections", "records", "write", "delete", "session"],
        },
        [
          { command: "joelclaw pds health", description: "Check PDS reachability and version" },
          { command: "joelclaw pds describe", description: "Describe the current repo" },
          { command: "joelclaw pds session", description: "Create or reuse a cached session" },
        ],
      ),
    )
  }),
).pipe(Command.withDescription("Operate the AT Protocol PDS surface"))

const healthCmd = Command.make("health", {}, () =>
  Effect.gen(function* () {
    const response = yield* Effect.promise(() => fetchJson("/xrpc/_health"))
    if (!response.ok) {
      yield* Console.log(
        respondError(
          "pds health",
          `PDS health probe failed (${response.status}): ${response.text}`,
          "PDS_HEALTH_FAILED",
          "Verify the bluesky-pds deployment and host port 9627 before retrying.",
          [
            { command: "kubectl get deploy,svc,pods,pvc -n joelclaw | rg 'bluesky-pds|NAME'", description: "Check bluesky-pds workload state" },
            { command: "kubectl logs -n joelclaw -l app.kubernetes.io/name=bluesky-pds --tail=50", description: "Inspect recent PDS logs" },
          ],
        ),
      )
      return
    }

    yield* Console.log(
      respond(
        "pds health",
        {
          url: PDS_URL,
          ...response.json,
        },
        [
          { command: "joelclaw pds describe", description: "Describe the current repo" },
          { command: "joelclaw pds session", description: "Verify session auth against the current repo" },
        ],
      ),
    )
  }),
).pipe(Command.withDescription("Check PDS reachability and version"))

const describeCmd = Command.make("describe", {}, () =>
  Effect.gen(function* () {
    const did = process.env.PDS_JOEL_DID?.trim() || leaseSecret("pds_joel_did") || DEFAULT_PDS_HANDLE
    const repo = yield* Effect.promise(() => describeCurrentRepo(did))

    if (!repo) {
      yield* Console.log(
        respondError(
          "pds describe",
          `Failed to describe repo for ${did}`,
          "PDS_REPO_NOT_FOUND",
          "Recreate Joel's PDS account after a wiped PVC, then update pds_joel_did to the new DID.",
          [
            { command: "joelclaw pds health", description: "Check that the PDS itself is reachable" },
            { command: "joelclaw secrets lease pds_joel_did --ttl 5m", description: "Inspect the stored repo DID" },
          ],
        ),
      )
      return
    }

    yield* Console.log(
      respond(
        "pds describe",
        repo,
        [
          { command: "joelclaw pds collections", description: "List repo collections" },
          { command: "joelclaw pds session", description: "Verify session auth against this repo" },
        ],
      ),
    )
  }),
).pipe(Command.withDescription("Describe the current PDS repo"))

const collectionsCmd = Command.make("collections", {}, () =>
  Effect.gen(function* () {
    const did = process.env.PDS_JOEL_DID?.trim() || leaseSecret("pds_joel_did") || DEFAULT_PDS_HANDLE
    const repo = yield* Effect.promise(() => describeCurrentRepo(did))

    if (!repo) {
      yield* Console.log(
        respondError(
          "pds collections",
          `Failed to load collections for ${did}`,
          "PDS_REPO_NOT_FOUND",
          "Recreate Joel's PDS account after a wiped PVC, then update pds_joel_did to the new DID.",
          [
            { command: "joelclaw pds describe", description: "Inspect repo identity and handle state" },
          ],
        ),
      )
      return
    }

    const collections = Array.isArray(repo.collections) ? repo.collections : []
    yield* Console.log(
      respond(
        "pds collections",
        {
          did: repo.did,
          handle: repo.handle,
          count: collections.length,
          collections,
        },
        [
          { command: "joelclaw pds records <collection> [--limit <limit>]", description: "List records from a collection" },
        ],
      ),
    )
  }),
).pipe(Command.withDescription("List collections in the current repo"))

const recordsLimit = Options.integer("limit").pipe(
  Options.withAlias("n"),
  Options.withDescription("Maximum records to list"),
  Options.withDefault(20),
)

const recordsCmd = Command.make(
  "records",
  {
    collection: Args.text({ name: "collection" }).pipe(Args.withDescription("Collection NSID")),
    limit: recordsLimit,
  },
  ({ collection, limit }) =>
    Effect.gen(function* () {
      const auth = yield* Effect.promise(() => authHeaders()).pipe(Effect.either)
      if (auth._tag === "Left") {
        yield* Console.log(
          respondError(
            "pds records",
            auth.left instanceof Error ? auth.left.message : "Failed to create PDS session",
            "PDS_SESSION_FAILED",
            "Verify pds_joel_did / pds_joel_password and the current repo handle, then retry.",
            [
              { command: "joelclaw pds session --refresh", description: "Force a fresh session" },
              { command: "joelclaw pds describe", description: "Check the current repo DID and handle" },
            ],
          ),
        )
        return
      }

      const { headers, session, cache } = auth.right
      const response = yield* Effect.promise(() =>
        fetchJson(
          `/xrpc/com.atproto.repo.listRecords?repo=${encodeURIComponent(session.did)}&collection=${encodeURIComponent(collection)}&limit=${limit}`,
          { headers },
        ),
      )

      if (!response.ok) {
        yield* Console.log(
          respondError(
            "pds records",
            `Failed to list records for ${collection} (${response.status}): ${response.text}`,
            "PDS_LIST_RECORDS_FAILED",
            "Verify the collection exists and session auth is still valid.",
            [
              { command: "joelclaw pds collections", description: "List current collections" },
              { command: "joelclaw pds session --refresh", description: "Refresh the cached session" },
            ],
          ),
        )
        return
      }

      yield* Console.log(
        respond(
          `pds records ${collection}`,
          {
            cache,
            did: session.did,
            handle: session.handle,
            collection,
            cursor: response.json?.cursor,
            records: response.json?.records ?? [],
          },
          [
            { command: "joelclaw pds write <collection> --data <json>", description: "Create a record in this collection" },
          ],
        ),
      )
    }),
).pipe(Command.withDescription("List records from a collection"))

const writeData = Options.text("data").pipe(
  Options.withAlias("d"),
  Options.withDescription("JSON object payload for the record body"),
)

const writeCmd = Command.make(
  "write",
  {
    collection: Args.text({ name: "collection" }).pipe(Args.withDescription("Collection NSID")),
    data: writeData,
  },
  ({ collection, data }) =>
    Effect.gen(function* () {
      let parsed: Record<string, unknown>
      try {
        const value = JSON.parse(data) as unknown
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          throw new Error("Record payload must be a JSON object")
        }
        parsed = value as Record<string, unknown>
      } catch (error) {
        yield* Console.log(
          respondError(
            "pds write",
            error instanceof Error ? error.message : "Invalid JSON payload",
            "PDS_INVALID_RECORD_JSON",
            "Pass a JSON object to --data, e.g. --data '{\"key\":\"value\"}'.",
            [],
          ),
        )
        return
      }

      const auth = yield* Effect.promise(() => authHeaders()).pipe(Effect.either)
      if (auth._tag === "Left") {
        yield* Console.log(
          respondError(
            "pds write",
            auth.left instanceof Error ? auth.left.message : "Failed to create PDS session",
            "PDS_SESSION_FAILED",
            "Verify pds_joel_did / pds_joel_password and the current repo handle, then retry.",
            [
              { command: "joelclaw pds session --refresh", description: "Force a fresh session" },
              { command: "joelclaw pds describe", description: "Check the current repo DID and handle" },
            ],
          ),
        )
        return
      }

      const { headers, session, cache } = auth.right
      const response = yield* Effect.promise(() =>
        fetchJson("/xrpc/com.atproto.repo.createRecord", {
          method: "POST",
          headers,
          body: JSON.stringify({
            repo: session.did,
            collection,
            record: {
              $type: collection,
              createdAt: new Date().toISOString(),
              ...parsed,
            },
          }),
        }),
      )

      if (!response.ok) {
        yield* Console.log(
          respondError(
            "pds write",
            `Failed to write ${collection} (${response.status}): ${response.text}`,
            "PDS_WRITE_FAILED",
            "Verify session auth and record shape, then retry.",
            [
              { command: "joelclaw pds session --refresh", description: "Refresh the cached session" },
              { command: "joelclaw pds describe", description: "Confirm the current repo DID and handle" },
            ],
          ),
        )
        return
      }

      yield* Console.log(
        respond(
          `pds write ${collection}`,
          {
            cache,
            did: session.did,
            handle: session.handle,
            collection,
            ...response.json,
          },
          [
            { command: "joelclaw pds records <collection> [--limit <limit>]", description: "List records in this collection" },
          ],
        ),
      )
    }),
).pipe(Command.withDescription("Create a record in the current repo"))

const deleteCmd = Command.make(
  "delete",
  {
    collection: Args.text({ name: "collection" }).pipe(Args.withDescription("Collection NSID")),
    rkey: Args.text({ name: "rkey" }).pipe(Args.withDescription("Record key to delete")),
  },
  ({ collection, rkey }) =>
    Effect.gen(function* () {
      const auth = yield* Effect.promise(() => authHeaders()).pipe(Effect.either)
      if (auth._tag === "Left") {
        yield* Console.log(
          respondError(
            "pds delete",
            auth.left instanceof Error ? auth.left.message : "Failed to create PDS session",
            "PDS_SESSION_FAILED",
            "Verify pds_joel_did / pds_joel_password and the current repo handle, then retry.",
            [
              { command: "joelclaw pds session --refresh", description: "Force a fresh session" },
              { command: "joelclaw pds describe", description: "Check the current repo DID and handle" },
            ],
          ),
        )
        return
      }

      const { headers, session, cache } = auth.right
      const response = yield* Effect.promise(() =>
        fetchJson("/xrpc/com.atproto.repo.deleteRecord", {
          method: "POST",
          headers,
          body: JSON.stringify({
            repo: session.did,
            collection,
            rkey,
          }),
        }),
      )

      if (!response.ok) {
        yield* Console.log(
          respondError(
            "pds delete",
            `Failed to delete ${collection}/${rkey} (${response.status}): ${response.text}`,
            "PDS_DELETE_FAILED",
            "Verify the record key exists and session auth is still valid.",
            [
              { command: "joelclaw pds records <collection> [--limit <limit>]", description: "List record keys in the collection" },
            ],
          ),
        )
        return
      }

      yield* Console.log(
        respond(
          `pds delete ${collection} ${rkey}`,
          {
            cache,
            did: session.did,
            handle: session.handle,
            collection,
            rkey,
            deleted: true,
          },
          [
            { command: "joelclaw pds records <collection> [--limit <limit>]", description: "Confirm the record is gone" },
          ],
        ),
      )
    }),
).pipe(Command.withDescription("Delete a record from the current repo"))

const sessionRefresh = Options.boolean("refresh").pipe(
  Options.withDescription("Force a fresh session instead of using the cache"),
  Options.withDefault(false),
)

const sessionCmd = Command.make(
  "session",
  { refresh: sessionRefresh },
  ({ refresh }) =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() => getSession(refresh)).pipe(Effect.either)
      if (result._tag === "Left") {
        yield* Console.log(
          respondError(
            "pds session",
            result.left instanceof Error ? result.left.message : "Failed to create PDS session",
            "PDS_SESSION_FAILED",
            "Verify pds_joel_did / pds_joel_password and the current repo handle, then retry.",
            [
              { command: "joelclaw pds describe", description: "Check the current repo DID and handle" },
              { command: "joelclaw secrets lease pds_joel_did --ttl 5m", description: "Inspect the stored repo DID" },
            ],
          ),
        )
        return
      }

      const { session, cache } = result.right
      yield* Console.log(
        respond(
          "pds session",
          {
            cache,
            cachePath: SESSION_CACHE_PATH,
            did: session.did,
            handle: session.handle,
            createdAt: new Date(session.createdAt).toISOString(),
            accessJwt: tokenSummary(session.accessJwt),
            refreshJwt: tokenSummary(session.refreshJwt),
          },
          [
            { command: "joelclaw pds describe", description: "Describe the current repo" },
            { command: "joelclaw pds collections", description: "List repo collections" },
          ],
        ),
      )
    }),
).pipe(Command.withDescription("Create or reuse a cached PDS session"))

export const pdsCmd = rootCmd.pipe(
  Command.withSubcommands([healthCmd, describeCmd, collectionsCmd, recordsCmd, writeCmd, deleteCmd, sessionCmd]),
)

export const __pdsTestUtils = {
  parseLeaseOutput,
  tokenSummary,
}
