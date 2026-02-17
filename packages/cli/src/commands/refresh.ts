import { Command } from "@effect/cli"
import { Console, Effect } from "effect"
import { loadConfig } from "../config"
import { respond } from "../response"

const cfg = loadConfig()
const GQL = `${cfg.inngestUrl}/v0/gql`
const WORKER = cfg.workerUrl

const gql = async (query: string) => {
  const res = await fetch(GQL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  })
  const json = await res.json() as { errors?: Array<{ message: string }>; data: any }
  if (json.errors?.length) throw new Error(json.errors[0].message)
  return json.data
}

/**
 * `joelclaw refresh` — reconcile Inngest function registry with what the worker serves.
 *
 * Deletes the app registration and re-registers from scratch.
 * The worker's PUT /api/inngest response is the source of truth.
 * Inngest has no "remove stale functions" API, so delete + re-register is it.
 */
export const refresh = Command.make("refresh", {}, () =>
  Effect.gen(function* () {
    // 1. Snapshot current state
    const before = yield* Effect.tryPromise({
      try: async () => {
        const data = await gql(`{
          apps { id name functions { name slug } }
        }`)
        const apps = data.apps as Array<{
          id: string; name: string
          functions: Array<{ name: string; slug: string }>
        }>
        return apps[0] ?? null
      },
      catch: (e) => ({ _tag: "RefreshError" as const, message: "Failed to query server", cause: e }),
    })

    // 2. Delete app if it exists (clears all function registrations)
    if (before) {
      yield* Effect.tryPromise({
        try: () => gql(`mutation { deleteApp(id: "${before.id}") }`),
        catch: (e) => ({ _tag: "RefreshError" as const, message: "Failed to delete app", cause: e }),
      })
      yield* Effect.sleep("1 second")
    }

    // 3. Re-register from worker (source of truth)
    const regResult = yield* Effect.tryPromise({
      try: async () => {
        const res = await fetch(`${WORKER}/api/inngest`, { method: "PUT" })
        return (await res.json()) as { message: string; modified: boolean }
      },
      catch: (e) => ({ _tag: "RefreshError" as const, message: "Failed to register worker", cause: e }),
    })

    yield* Effect.sleep("2 seconds")

    // 4. Verify new state
    const after = yield* Effect.tryPromise({
      try: async () => {
        const data = await gql(`{
          apps { name functionCount functions { name slug } }
        }`)
        const apps = data.apps as Array<{
          name: string; functionCount: number
          functions: Array<{ name: string; slug: string }>
        }>
        return apps[0] ?? null
      },
      catch: (e) => ({ _tag: "RefreshError" as const, message: "Failed to verify", cause: e }),
    })

    // 5. Diff
    const beforeNames = new Set(before?.functions.map((f) => f.name) ?? [])
    const afterNames = new Set(after?.functions.map((f) => f.name) ?? [])

    const removed = [...beforeNames].filter((n) => !afterNames.has(n))
    const added = [...afterNames].filter((n) => !beforeNames.has(n))
    const kept = [...afterNames].filter((n) => beforeNames.has(n))

    const changed = removed.length > 0 || added.length > 0

    return yield* Console.log(
      respond("refresh", {
        action: changed ? "refreshed" : "clean",
        functionCount: after?.functionCount ?? 0,
        ...(removed.length > 0 && { removed }),
        ...(added.length > 0 && { added }),
        functions: after?.functions.map((f) => f.name) ?? [],
      }, changed
        ? [
            { command: "joelclaw functions", description: "Verify registered functions" },
            { command: "joelclaw runs --count 3", description: "Check recent runs" },
          ]
        : []
      )
    )
  })
)
