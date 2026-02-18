/**
 * Things Cloud client — task access via reverse-engineered HTTP endpoints.
 *
 * Protocol reverse-engineered by Arthur Soares:
 * https://github.com/arthursoares/things-cloud-sdk
 *
 * ADR-0045: Task management via Ports and Adapters
 * ADR-0046: TypeScript Things CLI
 */

import { Effect } from "effect"

const THINGS_BASE_URL = "https://cloud.culturedcode.com"
const THINGS_CLIENT_INFO = {
  dm: "MacBookPro18,3",
  lr: "US",
  nf: true,
  nk: true,
  nn: "ThingsMac",
  nv: "32209501",
  on: "macOS",
  ov: "15.7.3",
  pl: "en-US",
  ul: "en-Latn-US",
}
const THINGS_CLIENT_INFO_B64 = Buffer.from(JSON.stringify(THINGS_CLIENT_INFO)).toString("base64")
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

export class TasksError {
  readonly _tag = "TasksError"
  constructor(readonly message: string, readonly cause?: unknown) {}
}

interface ThingsItem {
  uuid: string
  kind: "Task6" | "Tag4" | "Area3"
  action: 0 | 1 | 2
  md?: null
  p?: Record<string, unknown>
}

interface HistoryResponse {
  items: ThingsItem[]
  "current-item-index": number
}

interface TaskRecord {
  readonly uuid: string
  readonly title: string
  readonly schedule: number
  readonly status: number
  readonly index: number
  readonly scheduledDate?: string
  readonly deadline?: string
  readonly projectIds: readonly string[]
  readonly areaIds: readonly string[]
  readonly tagIds: readonly string[]
}

interface Credentials {
  username: string
  password: string
}

interface CreateOptions {
  readonly when?: "today" | "inbox" | "anytime" | "someday"
  readonly project?: string
  readonly note?: string
}

const todayLocal = (): string => {
  const d = new Date()
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

const normalizeDate = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.length === 0) return undefined
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  if (value.length >= 10) return value.slice(0, 10)
  return undefined
}

const encodeBase58 = (bytes: Uint8Array): string => {
  if (bytes.length === 0) return ""

  const digits = [0]
  for (const byte of bytes) {
    let carry = byte
    for (let i = 0; i < digits.length; i++) {
      const value = digits[i] * 256 + carry
      digits[i] = value % 58
      carry = Math.floor(value / 58)
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = Math.floor(carry / 58)
    }
  }

  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++

  let out = ""
  for (let i = 0; i < zeros; i++) out += BASE58_ALPHABET[0]
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58_ALPHABET[digits[i]]
  return out
}

const generateBase58Uuid = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return encodeBase58(bytes)
}

const asArray = (value: unknown): readonly string[] => {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === "string")
}

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;")

const toTaskRecord = (item: ThingsItem): TaskRecord | null => {
  if (item.kind !== "Task6" || !item.p) return null

  const p = item.p
  const title = typeof p.tt === "string" ? p.tt : ""
  const schedule = typeof p.st === "number" ? p.st : -1
  const status = typeof p.ss === "number" ? p.ss : 0
  const index = typeof p.ix === "number" ? p.ix : 0
  const taskType = typeof p.tp === "number" ? p.tp : 0
  const trashed = Boolean(p.tr)

  if (taskType !== 0 || trashed) return null

  return {
    uuid: item.uuid,
    title,
    schedule,
    status,
    index,
    scheduledDate: normalizeDate(p.sr ?? p.tir),
    deadline: normalizeDate(p.dl),
    projectIds: asArray(p.pr),
    areaIds: asArray(p.ar),
    tagIds: asArray(p.tg),
  }
}

const toTitleEntry = (item: ThingsItem): { uuid: string; title: string } | null => {
  if (!item.p || Boolean(item.p.tr)) return null
  const title = typeof item.p.tt === "string" ? item.p.tt : ""
  if (title.length === 0) return null
  return { uuid: item.uuid, title }
}

export class Tasks extends Effect.Service<Tasks>()("joelclaw/Tasks", {
  sync: () => {
    let cachedHistoryKey: string | null = null
    let cachedCredentials: Credentials | null = null

    const leaseSecret = (name: string) =>
      Effect.tryPromise({
        try: async () => {
          const proc = Bun.spawn(["secrets", "lease", name, "--raw"], {
            stdout: "pipe",
            stderr: "pipe",
          })
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
          ])

          if (exitCode !== 0) {
            throw new Error(`secrets lease ${name} failed: ${stderr.trim() || "unknown error"}`)
          }

          const value = stdout.trim()
          if (value.length === 0) {
            throw new Error(`secrets lease ${name} returned empty value`)
          }

          try {
            const parsed = JSON.parse(value) as unknown

            if (typeof parsed === "string" && parsed.trim().length > 0) {
              return parsed.trim()
            }

            if (typeof parsed === "object" && parsed !== null) {
              const parsedObj = parsed as {
                success?: unknown
                error?: unknown
                data?: { value?: unknown }
              }

              if (parsedObj.success === false) {
                throw new Error(
                  typeof parsedObj.error === "string"
                    ? parsedObj.error
                    : `secrets lease ${name} returned unsuccessful response`
                )
              }

              if (typeof parsedObj.data?.value === "string" && parsedObj.data.value.length > 0) {
                return parsedObj.data.value
              }
            }
          } catch (e) {
            if (e instanceof SyntaxError) {
              return value
            }
            throw e
          }

          return value
        },
        catch: (e) => new TasksError(`Failed to lease secret: ${name}`, e),
      })

    const credentials = Effect.fn("Tasks.credentials")(function* () {
      if (cachedCredentials) return cachedCredentials

      const username = process.env.THINGS_USERNAME ?? (yield* leaseSecret("things_username"))
      const password = process.env.THINGS_PASSWORD ?? (yield* leaseSecret("things_password"))

      cachedCredentials = { username, password }
      return cachedCredentials
    })

    const request = (
      method: "GET" | "POST",
      path: string,
      opts?: {
        body?: unknown
        password?: string
        extraHeaders?: Record<string, string>
      }
    ) =>
      Effect.tryPromise({
        try: async () => {
          const headers: Record<string, string> = {
            "User-Agent": "ThingsMac/32209501",
            Host: "cloud.culturedcode.com",
            Accept: "application/json",
            "Things-Client-Info": THINGS_CLIENT_INFO_B64,
            ...opts?.extraHeaders,
          }
          if (opts?.password) headers.Authorization = `Password ${opts.password}`
          if (opts?.body) headers["Content-Type"] = "application/json"

          const res = await fetch(`${THINGS_BASE_URL}${path}`, {
            method,
            headers,
            body: method === "POST" && opts?.body ? JSON.stringify(opts.body) : undefined,
            signal: AbortSignal.timeout(10_000),
          })

          const text = await res.text()
          let json: unknown = null
          if (text.length > 0) {
            try {
              json = JSON.parse(text)
            } catch {
              json = text
            }
          }

          if (!res.ok) {
            throw new Error(
              `Things ${method} ${path} ${res.status}: ${typeof json === "string" ? json : JSON.stringify(json)}`
            )
          }

          return json
        },
        catch: (e) => new TasksError(`Things request failed: ${method} ${path}`, e),
      })

    const verify = Effect.fn("Tasks.verify")(function* () {
      const creds = yield* credentials()
      const result = (yield* request("GET", `/version/1/account/${encodeURIComponent(creds.username)}`, {
        password: creds.password,
      })) as Record<string, unknown>

      const historyKey = result["history-key"]
      if (typeof historyKey === "string" && historyKey.length > 0) {
        cachedHistoryKey = historyKey
      }

      return {
        email: String(result.email ?? creds.username),
        status: String(result.status ?? "unknown"),
        historyKey: cachedHistoryKey,
      }
    })

    const historyKey = Effect.fn("Tasks.historyKey")(function* () {
      if (cachedHistoryKey) return cachedHistoryKey

      const creds = yield* credentials()
      const v = yield* verify()
      if (v.historyKey) return v.historyKey

      const keys = (yield* request(
        "GET",
        `/version/1/account/${encodeURIComponent(creds.username)}/own-history-keys`,
        { password: creds.password }
      )) as unknown

      const historyKeys = Array.isArray(keys)
        ? keys.filter((k): k is string => typeof k === "string")
        : []

      if (historyKeys.length === 0) {
        yield* Effect.fail(new TasksError("No Things history key found for account"))
        return "" as never
      }

      cachedHistoryKey = historyKeys[0]
      return cachedHistoryKey
    })

    const history = Effect.fn("Tasks.history")(function* () {
      const creds = yield* credentials()
      const hKey = yield* historyKey()

      const result = (yield* request(
        "GET",
        `/version/1/history/${encodeURIComponent(hKey)}/items?start-index=0`,
        { password: creds.password }
      )) as HistoryResponse

      return {
        items: Array.isArray(result.items) ? result.items : [],
        currentIndex:
          typeof result["current-item-index"] === "number"
            ? result["current-item-index"]
            : 0,
      }
    })

    const commit = Effect.fn("Tasks.commit")(function* (
      ancestorIndex: number,
      payload: Record<string, ThingsItem>
    ) {
      const creds = yield* credentials()
      const hKey = yield* historyKey()

      return (yield* request(
        "POST",
        `/version/1/history/${encodeURIComponent(hKey)}/commit?ancestor-index=${ancestorIndex}`,
        {
          password: creds.password,
          body: payload,
          extraHeaders: {
            Schema: "301",
            "Push-Priority": "5",
            "App-Id": "com.culturedcode.ThingsMac",
          },
        }
      )) as Record<string, unknown>
    })

    const today = Effect.fn("Tasks.today")(function* () {
      const all = yield* history()
      const todayDate = todayLocal()

      return all.items
        .map(toTaskRecord)
        .filter((t): t is TaskRecord => t !== null)
        .filter((t) => t.status !== 3)
        .filter((t) => t.schedule === 1)
        .filter((t) => t.scheduledDate === todayDate)
    })

    const inbox = Effect.fn("Tasks.inbox")(function* () {
      const all = yield* history()

      return all.items
        .map(toTaskRecord)
        .filter((t): t is TaskRecord => t !== null)
        .filter((t) => t.status !== 3)
        .filter((t) => t.schedule === 0)
    })

    const projects = Effect.fn("Tasks.projects")(function* () {
      const all = yield* history()

      return all.items
        .filter((i) => i.kind === "Task6" && i.p && i.p.tp === 1)
        .map(toTitleEntry)
        .filter((p): p is { uuid: string; title: string } => p !== null)
    })

    const areas = Effect.fn("Tasks.areas")(function* () {
      const all = yield* history()

      return all.items
        .filter((i) => i.kind === "Area3")
        .map(toTitleEntry)
        .filter((a): a is { uuid: string; title: string } => a !== null)
    })

    const create = Effect.fn("Tasks.create")(function* (
      title: string,
      opts?: CreateOptions
    ) {
      const all = yield* history()
      const when = opts?.when ?? "inbox"
      const todayDate = todayLocal()

      let schedule: 0 | 1 | 2 = 0
      let scheduledDate: string | undefined

      if (when === "inbox") schedule = 0
      if (when === "anytime") schedule = 1
      if (when === "someday") schedule = 2
      if (when === "today") {
        schedule = 1
        scheduledDate = todayDate
      }

      const uuid = generateBase58Uuid()
      const item: ThingsItem = {
        uuid,
        kind: "Task6",
        action: 0,
        md: null,
        p: {
          tt: title,
          tp: 0,
          ss: 0,
          st: schedule,
          ...(scheduledDate ? { sr: scheduledDate, tir: scheduledDate } : {}),
          ...(opts?.project ? { pr: [opts.project] } : {}),
          ...(opts?.note ? { nt: `<note>${escapeXml(opts.note)}</note>` } : {}),
        },
      }

      const result = yield* commit(all.currentIndex, { [uuid]: item })
      return { uuid, result }
    })

    const complete = Effect.fn("Tasks.complete")(function* (uuid: string) {
      const all = yield* history()
      const completionDate = todayLocal()

      const item: ThingsItem = {
        uuid,
        kind: "Task6",
        action: 1,
        p: {
          ss: 3,
          cd: completionDate,
          completionDate,
        },
      }

      const result = yield* commit(all.currentIndex, { [uuid]: item })
      return { uuid, result }
    })

    const search = Effect.fn("Tasks.search")(function* (query: string) {
      const q = query.trim().toLowerCase()
      const all = yield* history()

      return all.items
        .map(toTaskRecord)
        .filter((t): t is TaskRecord => t !== null)
        .filter((t) => (q.length === 0 ? true : t.title.toLowerCase().includes(q)))
    })

    return {
      verify,
      today,
      inbox,
      projects,
      areas,
      create,
      complete,
      search,
    } as const
  },
}) {}
