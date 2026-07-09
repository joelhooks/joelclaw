import { Command, Options } from "@effect/cli"
import {
  queryUsageRollup,
  queryUsageTotals,
  type UsageQueryOptions,
  type UsageRollupRow,
  type UsageTotals,
} from "@joelclaw/system-bus/src/lib/clickhouse-usage-query.ts"
import { Console, Effect } from "effect"
import { respond, respondError } from "../response"

type OptionalText = { _tag: "Some"; value: string } | { _tag: "None" }

function parseOptionText(value: OptionalText): string | undefined {
  if (value._tag !== "Some") return undefined
  const trimmed = value.value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const hoursOpt = Options.integer("hours").pipe(
  Options.withDefault(24),
  Options.withDescription("Lookback window in hours"),
)

const componentOpt = Options.text("component").pipe(
  Options.withDescription("Filter by OTEL component"),
  Options.optional,
)

const modelOpt = Options.text("model").pipe(
  Options.withDescription("Filter by model name"),
  Options.optional,
)

const machineOpt = Options.text("machine").pipe(
  Options.withDescription("Filter by machine (systemId)"),
  Options.optional,
)

const limitOpt = Options.integer("limit").pipe(
  Options.withDefault(500),
  Options.withDescription("Max rollup rows to return (cap 5000)"),
)

const jsonOpt = Options.boolean("json").pipe(
  Options.withDefault(false),
  Options.withDescription("Emit HATEOAS JSON envelope instead of the human table"),
)

const MAX_TABLE_ROWS = 20

function formatCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0.00"
  return `$${value.toFixed(value < 1 ? 4 : 2)}`
}

function formatTokens(value: number): string {
  return Math.round(value).toLocaleString("en-US")
}

function renderTable(rows: readonly UsageRollupRow[]): string {
  const header = ["day", "machine", "component", "model", "tokens in", "tokens out", "cost"]
  const body = rows.slice(0, MAX_TABLE_ROWS).map((row) => [
    row.day,
    row.systemId,
    row.component,
    row.model || "(none)",
    formatTokens(row.inputTokens),
    formatTokens(row.outputTokens),
    formatCost(row.costTotal),
  ])
  const table = [header, ...body]
  const widths = header.map((_, column) => Math.max(...table.map((line) => line[column]?.length ?? 0)))
  return table
    .map((line) => line.map((cell, column) => (cell ?? "").padEnd(widths[column] ?? 0)).join("  ").trimEnd())
    .join("\n")
}

function renderHuman(hours: number, totals: UsageTotals, rows: readonly UsageRollupRow[]): string {
  const totalsLine = [
    `usage (${hours}h):`,
    `calls ${formatTokens(totals.calls)}`,
    `| tokens in/out/total ${formatTokens(totals.inputTokens)}/${formatTokens(totals.outputTokens)}/${formatTokens(totals.totalTokens)}`,
    `| est cost ${formatCost(totals.costTotal)}`,
    `| usage coverage ${totals.usageCoveragePct}%`,
  ].join(" ")
  if (rows.length === 0) return `${totalsLine}\n(no model_router.result rows in window)`
  return `${totalsLine}\n\n${renderTable(rows)}`
}

export const usageCmd = Command.make(
  "usage",
  {
    hours: hoursOpt,
    component: componentOpt,
    model: modelOpt,
    machine: machineOpt,
    limit: limitOpt,
    json: jsonOpt,
  },
  ({ hours, component, model, machine, limit, json }) =>
    Effect.gen(function* () {
      const opts: UsageQueryOptions = {
        hours,
        component: parseOptionText(component),
        model: parseOptionText(model),
        systemId: parseOptionText(machine),
        limit,
      }

      // cli.ts strips --json from argv for backward compatibility, so read process.argv too.
      const asJson = json || process.argv.includes("--json")

      const result = yield* Effect.tryPromise({
        try: () => Promise.all([queryUsageTotals(opts), queryUsageRollup(opts)]),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }).pipe(Effect.either)

      if (result._tag === "Left") {
        yield* Console.log(
          respondError(
            "usage",
            result.left.message,
            "USAGE_QUERY_FAILED",
            "Check ClickHouse reachability: curl 'http://192.168.1.163:8123/?query=SELECT+1' (override with CLICKHOUSE_QUERY_URL)",
            [
              { command: "joelclaw status", description: "Check worker/server health" },
              { command: "joelclaw otel list --hours 24", description: "Inspect OTEL events via Typesense" },
            ],
          ),
        )
        return
      }

      const [totals, rows] = result.right

      if (asJson) {
        yield* Console.log(
          respond(
            "usage",
            { totals, rows },
            [
              { command: `joelclaw usage --hours ${hours} --model <model> --json`, description: "Narrow to one model" },
              { command: `joelclaw usage --hours ${hours} --machine <systemId> --json`, description: "Narrow to one machine" },
              { command: "joelclaw otel search model_router.result --hours 24", description: "Inspect raw router result events" },
            ],
          ),
        )
        return
      }

      yield* Console.log(renderHuman(hours, totals, rows))
    }),
).pipe(Command.withDescription("Token usage and cost rollup from ClickHouse model_router.result events"))
