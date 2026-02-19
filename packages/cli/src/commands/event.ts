/**
 * joelclaw event <id> — View an event and its function runs.
 *
 * Maps event IDs (from `joelclaw send`) to the runs they triggered.
 * Used by inngest-monitor pi extension for event → run resolution.
 */

import { Args, Command } from "@effect/cli"
import { Console, Effect } from "effect"
import { Inngest } from "../inngest"
import { respond } from "../response"
import type { NextAction } from "../response"

export const eventCmd = Command.make(
  "event",
  {
    eventId: Args.text({ name: "event-id" }).pipe(
      Args.withDescription("Event ID (ULID from joelclaw send)")
    ),
  },
  ({ eventId }) =>
    Effect.gen(function* () {
      const inngestClient = yield* Inngest
      const result = yield* inngestClient.event(eventId)

      const next: NextAction[] = []

      for (const run of result.runs) {
        next.push({
          command: `joelclaw run ${run.id}`,
          description: `Inspect ${run.status.toLowerCase()} ${run.functionName ?? run.functionID}`,
        })
      }

      next.push(
        { command: `joelclaw events --count 5`, description: "Recent events" },
        { command: `joelclaw runs --count 5`, description: "Recent runs" },
      )

      yield* Console.log(respond("event", result, next))
    })
)
