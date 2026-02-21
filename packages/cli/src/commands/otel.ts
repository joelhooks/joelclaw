import { Args, Command, Options } from "@effect/cli";
import { Console, Effect } from "effect";
import { respond, respondError } from "../response";

const TYPESENSE_URL = process.env.TYPESENSE_URL || "http://localhost:8108";
const COLLECTION = "otel_events";
const QUERY_BY = "action,error,component,source,metadata_json,search_text";

function getApiKey(): string {
  const envKey = process.env.TYPESENSE_API_KEY;
  if (envKey) return envKey;
  try {
    const { execSync } = require("node:child_process");
    return execSync("secrets lease typesense_api_key --ttl 15m", {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error("No TYPESENSE_API_KEY and secrets lease failed");
  }
}

function parseOptionText(value: { _tag: "Some"; value: string } | { _tag: "None" }): string | undefined {
  return value._tag === "Some" ? value.value : undefined;
}

function parsePositiveInt(value: number, fallback: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}

function splitCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildFilter(input: {
  level?: string;
  source?: string;
  component?: string;
  success?: string;
  hours?: number;
}): string | undefined {
  const filters: string[] = [];

  if (typeof input.hours === "number" && Number.isFinite(input.hours) && input.hours > 0) {
    const cutoff = Date.now() - input.hours * 60 * 60 * 1000;
    filters.push(`timestamp:>=${Math.floor(cutoff)}`);
  }

  const levels = splitCsv(input.level);
  if (levels.length > 0) filters.push(`level:=[${levels.join(",")}]`);

  const sources = splitCsv(input.source);
  if (sources.length > 0) filters.push(`source:=[${sources.join(",")}]`);

  const components = splitCsv(input.component);
  if (components.length > 0) filters.push(`component:=[${components.join(",")}]`);

  if (input.success === "true" || input.success === "false") {
    filters.push(`success:=${input.success}`);
  }

  return filters.length > 0 ? filters.join(" && ") : undefined;
}

type OtelQueryResult = { ok: true; data: any } | { ok: false; error: string };

async function queryOtel(options: {
  q: string;
  page: number;
  limit: number;
  filterBy?: string;
  facetBy?: string;
}): Promise<OtelQueryResult> {
  try {
    const apiKey = getApiKey();
    const searchParams = new URLSearchParams({
      q: options.q,
      query_by: QUERY_BY,
      per_page: String(options.limit),
      page: String(options.page),
      sort_by: "timestamp:desc",
      exclude_fields: "embedding",
    });
    if (options.filterBy) searchParams.set("filter_by", options.filterBy);
    if (options.facetBy) searchParams.set("facet_by", options.facetBy);

    const resp = await fetch(
      `${TYPESENSE_URL}/collections/${COLLECTION}/documents/search?${searchParams}`,
      {
        headers: { "X-TYPESENSE-API-KEY": apiKey },
      }
    );
    if (!resp.ok) {
      const text = await resp.text();
      return { ok: false, error: `Typesense query failed (${resp.status}): ${text}` };
    }
    return { ok: true, data: await resp.json() };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

function simplifyHit(hit: any): Record<string, unknown> {
  const doc = hit?.document ?? {};
  return {
    id: doc.id,
    ts: typeof doc.timestamp === "number" ? new Date(doc.timestamp).toISOString() : doc.timestamp,
    level: doc.level,
    source: doc.source,
    component: doc.component,
    action: doc.action,
    success: doc.success,
    duration_ms: doc.duration_ms,
    error: doc.error,
    metadata_keys: doc.metadata_keys,
  };
}

function readFacet(data: any, field: string, value: string): number {
  const facets = Array.isArray(data?.facet_counts) ? data.facet_counts : [];
  const facet = facets.find((item: any) => item?.field_name === field);
  const count = Array.isArray(facet?.counts)
    ? facet.counts.find((item: any) => item?.value === value)?.count
    : 0;
  return typeof count === "number" ? count : 0;
}

const levelOpt = Options.text("level").pipe(
  Options.withDescription("Comma-separated levels (debug,info,warn,error,fatal)"),
  Options.optional
);

const sourceOpt = Options.text("source").pipe(
  Options.withDescription("Comma-separated source filter"),
  Options.optional
);

const componentOpt = Options.text("component").pipe(
  Options.withDescription("Comma-separated component filter"),
  Options.optional
);

const successOpt = Options.text("success").pipe(
  Options.withDescription("true | false"),
  Options.optional
);

const hoursOpt = Options.integer("hours").pipe(
  Options.withAlias("h"),
  Options.withDefault(24),
  Options.withDescription("Lookback window in hours")
);

const limitOpt = Options.integer("limit").pipe(
  Options.withAlias("n"),
  Options.withDefault(30),
  Options.withDescription("Results per page")
);

const pageOpt = Options.integer("page").pipe(
  Options.withDefault(1),
  Options.withDescription("Page number")
);

const otelListCmd = Command.make(
  "list",
  {
    level: levelOpt,
    source: sourceOpt,
    component: componentOpt,
    success: successOpt,
    hours: hoursOpt,
    limit: limitOpt,
    page: pageOpt,
  },
  ({ level, source, component, success, hours, limit, page }) =>
    Effect.gen(function* () {
      const filterBy = buildFilter({
        level: parseOptionText(level),
        source: parseOptionText(source),
        component: parseOptionText(component),
        success: parseOptionText(success),
        hours,
      });
      const result = yield* Effect.promise(() =>
        queryOtel({
          q: "*",
          page: parsePositiveInt(page, 1, 10_000),
          limit: parsePositiveInt(limit, 30, 200),
          filterBy,
          facetBy: "level,source,component,success",
        })
      );

      if (!result.ok) {
        yield* Console.log(
          respondError(
            "otel list",
            result.error,
            "OTEL_QUERY_FAILED",
            "Check Typesense health and API key",
            [{ command: "joelclaw status", description: "Check worker/server health" }]
          )
        );
        return;
      }

      const hits = Array.isArray(result.data?.hits) ? result.data.hits.map(simplifyHit) : [];
      yield* Console.log(
        respond(
          "otel list",
          {
            found: result.data?.found ?? 0,
            page,
            limit,
            filterBy,
            events: hits,
            facets: result.data?.facet_counts ?? [],
          },
          [
            { command: `joelclaw otel search "fatal" --hours 24`, description: "Search text in recent events" },
            { command: "joelclaw otel stats --hours 24", description: "Error-rate snapshot" },
          ]
        )
      );
    })
);

const searchArg = Args.text({ name: "query" }).pipe(Args.withDescription("Full-text query"));

const otelSearchCmd = Command.make(
  "search",
  {
    query: searchArg,
    level: levelOpt,
    source: sourceOpt,
    component: componentOpt,
    success: successOpt,
    hours: hoursOpt,
    limit: limitOpt,
    page: pageOpt,
  },
  ({ query, level, source, component, success, hours, limit, page }) =>
    Effect.gen(function* () {
      const filterBy = buildFilter({
        level: parseOptionText(level),
        source: parseOptionText(source),
        component: parseOptionText(component),
        success: parseOptionText(success),
        hours,
      });
      const result = yield* Effect.promise(() =>
        queryOtel({
          q: query.trim() || "*",
          page: parsePositiveInt(page, 1, 10_000),
          limit: parsePositiveInt(limit, 30, 200),
          filterBy,
          facetBy: "level,source,component,success",
        })
      );

      if (!result.ok) {
        yield* Console.log(
          respondError(
            "otel search",
            result.error,
            "OTEL_QUERY_FAILED",
            "Check Typesense health and API key",
            [{ command: "joelclaw status", description: "Check worker/server health" }]
          )
        );
        return;
      }

      const hits = Array.isArray(result.data?.hits) ? result.data.hits.map(simplifyHit) : [];
      yield* Console.log(
        respond(
          "otel search",
          {
            query,
            found: result.data?.found ?? 0,
            page,
            limit,
            filterBy,
            events: hits,
            facets: result.data?.facet_counts ?? [],
          },
          [
            {
              command: `joelclaw otel search "${query}" --level error,fatal --hours 24`,
              description: "Narrow to high-severity",
            },
            { command: "joelclaw otel stats --hours 24", description: "Get aggregate error rate" },
          ]
        )
      );
    })
);

const otelStatsCmd = Command.make(
  "stats",
  {
    source: sourceOpt,
    component: componentOpt,
    hours: hoursOpt,
  },
  ({ source, component, hours }) =>
    Effect.gen(function* () {
      const baseFilter = buildFilter({
        source: parseOptionText(source),
        component: parseOptionText(component),
        hours,
      });
      const [windowData, recentData] = yield* Effect.promise(() =>
        Promise.all([
          queryOtel({
            q: "*",
            page: 1,
            limit: 1,
            filterBy: baseFilter,
            facetBy: "level,source,component,success",
          }),
          queryOtel({
            q: "*",
            page: 1,
            limit: 1,
            filterBy: buildFilter({
              source: parseOptionText(source),
              component: parseOptionText(component),
              hours: 0.25,
            }),
            facetBy: "level",
          }),
        ])
      );

      if (!windowData.ok) {
        yield* Console.log(
          respondError(
            "otel stats",
            windowData.error,
            "OTEL_STATS_FAILED",
            "Check Typesense health and API key",
            [{ command: "joelclaw status", description: "Check worker/server health" }]
          )
        );
        return;
      }

      if (!recentData.ok) {
        yield* Console.log(
          respondError(
            "otel stats",
            recentData.error,
            "OTEL_STATS_FAILED",
            "Check Typesense health and API key",
            [{ command: "joelclaw status", description: "Check worker/server health" }]
          )
        );
        return;
      }

      const total = Number(windowData.data?.found ?? 0);
      const errors = readFacet(windowData.data, "level", "error") + readFacet(windowData.data, "level", "fatal");
      const recentTotal = Number(recentData.data?.found ?? 0);
      const recentErrors = readFacet(recentData.data, "level", "error") + readFacet(recentData.data, "level", "fatal");

      yield* Console.log(
        respond(
          "otel stats",
          {
            windowHours: hours,
            filterBy: baseFilter,
            total,
            errors,
            errorRate: total > 0 ? errors / total : 0,
            recent15m: {
              total: recentTotal,
              errors: recentErrors,
              errorRate: recentTotal > 0 ? recentErrors / recentTotal : 0,
            },
            facets: windowData.data?.facet_counts ?? [],
          },
          [
            { command: "joelclaw otel list --level error,fatal --hours 24", description: "Inspect high severity events" },
            { command: `joelclaw otel search "system.fatal" --hours 48`, description: "Find escalation history" },
          ]
        )
      );
    })
);

export const otelCmd = Command.make("otel", {}, () =>
  Console.log(
    respond(
      "otel",
      {
        description: "Observability event explorer (ADR-0087)",
        subcommands: {
          list: "joelclaw otel list [--hours 24] [--level error,fatal]",
          search: 'joelclaw otel search "query" [filters]',
          stats: "joelclaw otel stats [--hours 24]",
        },
      },
      [
        { command: "joelclaw otel list --hours 24", description: "Recent events" },
        { command: 'joelclaw otel search "gateway" --level error,fatal --hours 24', description: "Search failures by text" },
        { command: "joelclaw otel stats --hours 24", description: "Error-rate snapshot" },
      ],
      true
    )
  )
).pipe(Command.withSubcommands([otelListCmd, otelSearchCmd, otelStatsCmd]));
