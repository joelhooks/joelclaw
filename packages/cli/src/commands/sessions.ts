import { Buffer } from "node:buffer"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { respond, respondError } from "../response"
import { isTypesenseApiKeyError, resolveTypesenseApiKey } from "../typesense-auth"

const TYPESENSE_URL = process.env.TYPESENSE_URL || "http://localhost:8108"
const RUN_CHUNKS_COLLECTION = "run_chunks_dev"
const SESSION_SEARCH_SOURCES = ["typesense", "ssh", "local", "both"] as const

type SessionSearchSource = typeof SESSION_SEARCH_SOURCES[number]

type SessionHit = {
  source: "typesense" | "ssh" | "local"
  id: string
  runId?: string
  sessionId?: string
  machineId?: string
  startedAt?: string
  role?: string
  path?: string
  cwdKey?: string
  score?: number
  snippets: string[]
}

type TypesenseHit = {
  document?: Record<string, unknown>
  highlights?: Array<{ field?: string; snippet?: string; value?: string }>
  text_match?: number
  text_match_info?: { score?: number }
}

type TypesenseSearchResponse = {
  found?: number
  hits?: TypesenseHit[]
}

type RemoteSearchResponse = {
  ok?: boolean
  host?: string
  root?: string
  query?: string
  found?: number
  searched_files?: number
  max_files?: number
  hits?: Array<{
    path?: string
    session_id?: string
    started_at?: string
    cwd_key?: string
    mtime?: string
    snippets?: string[]
  }>
  error?: string
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function quoteFilterValue(value: string): string {
  return `\`${value.replace(/`/g, "\\`")}\``
}

function timestampFromMillis(value: unknown): string | undefined {
  const millis = asNumber(value)
  return millis == null ? undefined : new Date(millis).toISOString()
}

function firstHighlight(hit: TypesenseHit): string | undefined {
  for (const highlight of hit.highlights ?? []) {
    const snippet = asString(highlight.snippet) ?? asString(highlight.value)
    if (snippet) return snippet
  }
  return undefined
}

function tagsSessionId(doc: Record<string, unknown>): string | undefined {
  const tags = Array.isArray(doc.tags) ? doc.tags : []
  for (const tag of tags) {
    if (typeof tag === "string" && tag.startsWith("session:")) {
      return tag.slice("session:".length)
    }
  }
  return undefined
}

async function searchTypesense(input: {
  query: string
  machine: string
  limit: number
}): Promise<{ ok: true; found: number; hits: SessionHit[] }> {
  const apiKey = resolveTypesenseApiKey()
  const params = new URLSearchParams({
    q: input.query,
    query_by: "text",
    per_page: String(input.limit),
    sort_by: "started_at:desc",
    include_fields: "id,run_id,machine_id,started_at,role,text,tags",
    exclude_fields: "embedding",
  })

  const filters = ["agent_runtime:=pi"]
  if (input.machine && input.machine !== "all") {
    filters.push(`machine_id:=${quoteFilterValue(input.machine)}`)
  }
  params.set("filter_by", filters.join(" && "))

  const response = await fetch(
    `${TYPESENSE_URL}/collections/${RUN_CHUNKS_COLLECTION}/documents/search?${params}`,
    { headers: { "X-TYPESENSE-API-KEY": apiKey } }
  )

  if (!response.ok) {
    throw new Error(`Typesense session search failed (${response.status}): ${await response.text()}`)
  }

  const body = (await response.json()) as TypesenseSearchResponse
  const hits = (body.hits ?? []).map<SessionHit>((hit) => {
    const doc = hit.document ?? {}
    const runId = asString(doc.run_id)
    const id = asString(doc.id) ?? runId ?? "unknown"
    const text = asString(doc.text)
    const snippet = firstHighlight(hit) ?? (text ? text.replace(/\s+/g, " ").slice(0, 500) : "")

    return {
      source: "typesense",
      id,
      runId,
      sessionId: tagsSessionId(doc),
      machineId: asString(doc.machine_id),
      startedAt: timestampFromMillis(doc.started_at),
      role: asString(doc.role),
      score: asNumber(hit.text_match) ?? asNumber(hit.text_match_info?.score),
      snippets: snippet ? [snippet] : [],
    }
  })

  return { ok: true, found: body.found ?? hits.length, hits }
}

const REMOTE_SESSION_SEARCH_SCRIPT = String.raw`
import base64
import datetime
import json
import os
import sys

args = json.loads(base64.b64decode(sys.argv[1]).decode("utf-8"))
query = str(args.get("query") or "")
limit = int(args.get("limit") or 8)
max_files = int(args.get("max_files") or 2000)
root = os.path.expanduser(str(args.get("root") or "~/.pi/agent/sessions"))
query_l = query.lower()
terms = [term for term in query_l.split() if term]

def flatten(value):
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float, bool)):
        return str(value)
    if isinstance(value, list):
        return " ".join(flatten(item) for item in value)
    if isinstance(value, dict):
        parts = []
        for key in ("role", "type", "toolName", "name", "content", "text", "message", "arguments"):
            if key in value:
                parts.append(flatten(value.get(key)))
        if not parts:
            parts = [flatten(v) for v in value.values()]
        return " ".join(part for part in parts if part)
    return str(value)

def matches(text):
    lower = text.lower()
    if query_l and query_l in lower:
        return True
    return bool(terms) and all(term in lower for term in terms)

def snippet(text):
    clean = " ".join(text.split())
    lower = clean.lower()
    index = lower.find(query_l) if query_l else -1
    if index < 0 and terms:
        index = min([lower.find(term) for term in terms if lower.find(term) >= 0] or [-1])
    if index < 0:
        return clean[:500]
    start = max(0, index - 180)
    end = min(len(clean), index + 320)
    return clean[start:end]

def normalize_started(raw):
    # Pi filenames use 2026-05-20T15-24-37-070Z. Return ISO-ish UTC.
    try:
        date, rest = raw.split("T", 1)
        rest = rest[:-1] if rest.endswith("Z") else rest
        hour, minute, second, millis = rest.split("-", 3)
        return f"{date}T{hour}:{minute}:{second}.{millis}Z"
    except Exception:
        return raw

def session_meta(path):
    base = os.path.basename(path)
    stem = base[:-6] if base.endswith(".jsonl") else base
    if "_" in stem:
        started, session_id = stem.rsplit("_", 1)
    else:
        started, session_id = "", stem
    return normalize_started(started), session_id

files = []
for dirpath, _dirnames, filenames in os.walk(root):
    for name in filenames:
        if not name.endswith(".jsonl"):
            continue
        path = os.path.join(dirpath, name)
        try:
            stat = os.stat(path)
        except OSError:
            continue
        files.append((stat.st_mtime, path))
files.sort(reverse=True)

hits = []
searched = 0
for _mtime, path in files[:max_files]:
    searched += 1
    snippets = []
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as handle:
            for line in handle:
                text = line
                try:
                    text = flatten(json.loads(line))
                except Exception:
                    pass
                if matches(text):
                    snippets.append(snippet(text))
                    if len(snippets) >= 3:
                        break
    except OSError:
        continue
    if not snippets:
        continue

    started, session_id = session_meta(path)
    hits.append({
        "path": path,
        "session_id": session_id,
        "started_at": started,
        "cwd_key": os.path.basename(os.path.dirname(path)),
        "mtime": datetime.datetime.fromtimestamp(_mtime, datetime.timezone.utc).isoformat(),
        "snippets": snippets,
    })
    if len(hits) >= limit:
        break

print(json.dumps({
    "ok": True,
    "root": root,
    "query": query,
    "found": len(hits),
    "searched_files": searched,
    "max_files": max_files,
    "hits": hits,
}))
`

function parseRawSessionSearch(input: {
  parsed: RemoteSearchResponse
  source: "ssh" | "local"
  machineId: string
}): { ok: true; found: number; searchedFiles?: number; hits: SessionHit[] } {
  if (input.parsed.ok === false) throw new Error(input.parsed.error ?? `${input.source} session search failed`)

  const hits = (input.parsed.hits ?? []).map<SessionHit>((hit) => ({
    source: input.source,
    id: asString(hit.session_id) ?? asString(hit.path) ?? "unknown",
    sessionId: asString(hit.session_id),
    machineId: input.machineId,
    startedAt: asString(hit.started_at),
    path: asString(hit.path),
    cwdKey: asString(hit.cwd_key),
    snippets: Array.isArray(hit.snippets) ? hit.snippets.filter((item): item is string => typeof item === "string") : [],
  }))

  return { ok: true, found: input.parsed.found ?? hits.length, searchedFiles: input.parsed.searched_files, hits }
}

function rawSessionPayload(input: { query: string; limit: number; maxFiles: number }): string {
  return Buffer.from(JSON.stringify({
    query: input.query,
    limit: input.limit,
    max_files: input.maxFiles,
  })).toString("base64")
}

function searchLocal(input: {
  query: string
  limit: number
  machine: string
  maxFiles: number
}): { ok: true; found: number; searchedFiles?: number; hits: SessionHit[] } {
  const proc = spawnSync("python3", ["-", rawSessionPayload(input)], {
    input: REMOTE_SESSION_SEARCH_SCRIPT,
    encoding: "utf8",
    timeout: 45_000,
    maxBuffer: 1024 * 1024 * 4,
  })

  if (proc.error) throw proc.error
  if (proc.status !== 0) {
    throw new Error(`local session search failed (${proc.status}): ${proc.stderr || proc.stdout}`)
  }

  return parseRawSessionSearch({
    parsed: JSON.parse(proc.stdout) as RemoteSearchResponse,
    source: "local",
    machineId: input.machine,
  })
}

function searchRemote(input: {
  query: string
  limit: number
  sshTarget: string
  maxFiles: number
}): { ok: true; found: number; searchedFiles?: number; hits: SessionHit[] } {
  const proc = spawnSync("ssh", [input.sshTarget, "python3", "-", rawSessionPayload(input)], {
    input: REMOTE_SESSION_SEARCH_SCRIPT,
    encoding: "utf8",
    timeout: 45_000,
    maxBuffer: 1024 * 1024 * 4,
  })

  if (proc.error) throw proc.error
  if (proc.status !== 0) {
    throw new Error(`ssh session search failed (${proc.status}): ${proc.stderr || proc.stdout}`)
  }

  return parseRawSessionSearch({
    parsed: JSON.parse(proc.stdout) as RemoteSearchResponse,
    source: "ssh",
    machineId: input.sshTarget.includes("dark-wizard") ? "dark-wizard" : input.sshTarget,
  })
}

function localHostname(): string | undefined {
  const proc = spawnSync("hostname", [], { encoding: "utf8", timeout: 2_000 })
  if (proc.status !== 0) return undefined
  return proc.stdout.trim().toLowerCase()
}

function isLocalMachine(machine: string): boolean {
  const hostname = localHostname()
  if (!hostname) return false
  const normalized = machine.toLowerCase()
  return hostname === normalized || hostname === `${normalized}.local`
}

function hasLocalTypesenseCredential(): boolean {
  if (process.env.TYPESENSE_API_KEY?.trim()) return true
  const systemBusEnv = join(process.env.HOME ?? "", ".config", "system-bus.env")
  return existsSync(systemBusEnv)
}

function mergeHits(typesenseHits: SessionHit[], sshHits: SessionHit[], limit: number): SessionHit[] {
  const merged: SessionHit[] = []
  const seen = new Set<string>()
  for (const hit of [...typesenseHits, ...sshHits]) {
    const key = hit.runId ?? hit.sessionId ?? hit.path ?? hit.id
    if (seen.has(`${hit.source}:${key}`)) continue
    seen.add(`${hit.source}:${key}`)
    merged.push(hit)
    if (merged.length >= limit * 2) break
  }
  return merged
}

const searchQueryArg = Args.text({ name: "query" }).pipe(
  Args.withDescription("Search query for session/run text")
)

const sourceOpt = Options.choice("source", SESSION_SEARCH_SOURCES).pipe(
  Options.withDefault("both" as SessionSearchSource),
  Options.withDescription("Search source: Typesense derived chunks, local raw Pi sessions, SSH raw Pi sessions, or both")
)

const machineOpt = Options.text("machine").pipe(
  Options.withDefault("dark-wizard"),
  Options.withDescription("Machine filter for Typesense results; use 'all' for every machine")
)

const sshTargetOpt = Options.text("ssh-target").pipe(
  Options.withDefault("joel@dark-wizard"),
  Options.withDescription("SSH target for raw remote Pi session search")
)

const limitOpt = Options.integer("limit").pipe(
  Options.withAlias("n"),
  Options.withDefault(8),
  Options.withDescription("Results per source")
)

const maxFilesOpt = Options.integer("max-files").pipe(
  Options.withDefault(2000),
  Options.withDescription("Maximum remote .jsonl files to scan over SSH")
)

const searchCmd = Command.make(
  "search",
  {
    query: searchQueryArg,
    source: sourceOpt,
    machine: machineOpt,
    sshTarget: sshTargetOpt,
    limit: limitOpt,
    maxFiles: maxFilesOpt,
  },
  ({ query, source, machine, sshTarget, limit, maxFiles }) =>
    Effect.gen(function* () {
      try {
        const rawSource = source === "both"
          ? (isLocalMachine(machine) ? "local" : "ssh")
          : source
        const sources = source === "both" ? ["typesense", rawSource] as const : [rawSource]
        const skipTypesense = source === "both" && rawSource === "local" && !hasLocalTypesenseCredential()
        const typesense = sources.includes("typesense") && !skipTypesense
          ? yield* Effect.promise(() => searchTypesense({ query, machine, limit }))
          : undefined
        const local = sources.includes("local")
          ? searchLocal({ query, limit, machine, maxFiles })
          : undefined
        const remote = sources.includes("ssh")
          ? searchRemote({ query, limit, sshTarget, maxFiles })
          : undefined

        const hits = mergeHits(typesense?.hits ?? [], [...(local?.hits ?? []), ...(remote?.hits ?? [])], limit)

        yield* Console.log(respond("sessions search", {
          query,
          source,
          resolvedRawSource: source === "both" ? rawSource : undefined,
          machine,
          sshTarget: sources.includes("ssh") ? sshTarget : undefined,
          typesense: typesense ? { found: typesense.found, returned: typesense.hits.length } : undefined,
          typesenseSkipped: skipTypesense ? "missing local TYPESENSE_API_KEY or ~/.config/system-bus.env; raw local search still ran" : undefined,
          local: local ? { found: local.found, returned: local.hits.length, searchedFiles: local.searchedFiles } : undefined,
          ssh: remote ? { found: remote.found, returned: remote.hits.length, searchedFiles: remote.searchedFiles } : undefined,
          hits,
        }, [
          {
            command: `sessions search "${query.replace(/"/g, "\\\"")}" --source typesense --machine ${machine} --limit ${limit}`,
            description: "Search Central Typesense session chunks only",
          },
          {
            command: `sessions search "${query.replace(/"/g, "\\\"")}" --source local --machine ${machine} --limit ${limit}`,
            description: "Search raw local Pi session files",
          },
          {
            command: `sessions search "${query.replace(/"/g, "\\\"")}" --source ssh --ssh-target ${sshTarget} --limit ${limit}`,
            description: "Search raw remote Pi session files over SSH",
          },
          {
            command: "knowledge search \"typesense session indexing recovery runbook\"",
            description: "Find the recovery runbook when Typesense is stale or session search looks wrong",
          },
        ]))
      } catch (error) {
        if (isTypesenseApiKeyError(error)) {
          yield* Console.log(respondError(
            "sessions search",
            error.message,
            error.code,
            error.fix,
            [
              { command: "secrets status", description: "Check agent-secrets health" },
              { command: "sessions search <query> --source local", description: "Bypass Typesense and search raw local session files", params: { query: { required: true } } },
              { command: "sessions search <query> --source ssh", description: "Bypass Typesense and search raw remote session files", params: { query: { required: true } } },
            ]
          ))
          return
        }

        const message = error instanceof Error ? error.message : String(error)
        const code = message.includes("ssh") ? "SESSION_SEARCH_SSH_FAILED" : "SESSION_SEARCH_FAILED"
        yield* Console.log(respondError(
          "sessions search",
          message,
          code,
          code === "SESSION_SEARCH_SSH_FAILED"
            ? "Verify SSH access: ssh joel@dark-wizard 'hostname && python3 --version'"
            : message.includes("local session search")
              ? "Verify local Pi sessions and Python: python3 --version && find ~/.pi/agent/sessions -type f -name '*.jsonl' | head"
              : "Check Typesense health and the session indexing runbook",
          [
            { command: "status", description: "Check joelclaw service health" },
            { command: "knowledge search \"typesense session indexing recovery runbook\"", description: "Find the session indexing recovery runbook" },
          ]
        ))
      }
    })
).pipe(Command.withDescription("Search captured Runs and raw remote Pi sessions"))

export const sessionsCmd = Command.make("sessions", {}, () =>
  Effect.gen(function* () {
    yield* Console.log(respond("sessions", {
      description: "Search captured agent Runs in Typesense and raw local/remote Pi session files",
      commands: {
        search: "joelclaw sessions search <query> [--source typesense|local|ssh|both] [--machine dark-wizard] [--ssh-target joel@dark-wizard] [--limit 8]",
      },
    }, [
      {
        command: "sessions search <query> --source both --machine dark-wizard",
        description: "Search dark-wizard sessions through Typesense and raw SSH fallback",
        params: { query: { required: true, description: "Search terms" } },
      },
      {
        command: "knowledge search \"typesense session indexing recovery runbook\"",
        description: "Find the troubleshooting runbook",
      },
    ]))
  })
).pipe(
  Command.withDescription("Search agent session history across Typesense and SSH bridges"),
  Command.withSubcommands([searchCmd])
)
