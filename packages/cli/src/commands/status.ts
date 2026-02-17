import { Command } from "@effect/cli"
import { Console, Effect } from "effect"
import { Inngest } from "../inngest"
import { respond } from "../response"

export const statusCmd = Command.make(
  "status",
  {},
  () =>
    Effect.gen(function* () {
      const inngestClient = yield* Inngest
      const checks = yield* inngestClient.health()
      const allOk = Object.values(checks).every((c) => c.ok)

      const next = []
      if (!checks.server?.ok) {
        next.push({ command: `kubectl rollout restart statefulset/inngest -n joelclaw`, description: "Restart Inngest pod" })
      }
      if (!checks.worker?.ok) {
        next.push({ command: `launchctl kickstart -k gui/$(id -u)/com.joel.system-bus-worker`, description: "Restart worker" })
      }
      next.push(
        { command: `joelclaw functions`, description: "View registered functions" },
        { command: `joelclaw runs --count 5`, description: "Recent runs" },
        { command: `joelclaw logs errors`, description: "Check worker errors" },
      )

      yield* Console.log(respond("status", checks, next, allOk))
    })
)

export const functionsCmd = Command.make(
  "functions",
  {},
  () =>
    Effect.gen(function* () {
      const inngestClient = yield* Inngest
      const fns = yield* inngestClient.functions()

      const next = fns.flatMap((f) =>
        f.triggers.slice(0, 1).map((t) => ({
          command: `joelclaw send ${t.value} -d '{}'`,
          description: `Trigger ${f.name}`,
        }))
      )
      next.push({ command: `joelclaw runs --count 5`, description: "See recent runs" })

      yield* Console.log(respond("functions", { count: fns.length, functions: fns }, next))
    })
)
