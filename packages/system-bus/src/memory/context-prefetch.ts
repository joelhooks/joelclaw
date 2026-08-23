import { createHash } from "node:crypto"
import {
  createComposedRecallRequest,
  formatRecallText,
  type RecallAccessPolicy,
  type RecallScopePolicy,
  runComposedRecallCli,
} from "@joelclaw/recall"
import { emitOtelEvent } from "../observability/emit"

export type MemoryPrefetchOptions = {
  readonly scope: RecallScopePolicy
  readonly access: RecallAccessPolicy
  readonly limit?: number
  readonly includeSuperseded?: boolean
  readonly timeoutMs?: number
}

type MemoryPrefetchDependencies = {
  readonly runRecall?: typeof runComposedRecallCli
  readonly emitTelemetry?: typeof emitOtelEvent
}

function scopeHash(scope: RecallScopePolicy): string {
  return createHash("sha256").update(`${scope.project}\u0000${scope.workstream}`).digest("hex")
}

export function buildPrefetchTelemetryMetadata(options: MemoryPrefetchOptions, limit: number) {
  return {
    scopeHash: scopeHash(options.scope),
    principalClass: options.access.principalRef.split(":", 1)[0] || "unknown",
    limit,
  }
}

export async function prefetchMemoryContext(
  query: string,
  options: MemoryPrefetchOptions,
  dependencies: MemoryPrefetchDependencies = {},
): Promise<string> {
  const startedAt = Date.now()
  const trimmed = query.trim()
  if (!trimmed) return ""

  const limit = Math.max(1, Math.min(options.limit ?? 5, 50))
  const metadata = buildPrefetchTelemetryMetadata(options, limit)
  const emitTelemetry = dependencies.emitTelemetry ?? emitOtelEvent

  try {
    const parsed = await (dependencies.runRecall ?? runComposedRecallCli)({
      request: createComposedRecallRequest({
        query: trimmed,
        scope: options.scope,
        access: options.access,
        includeSuperseded: options.includeSuperseded,
        limits: { curated: limit, observations: limit, reflections: limit },
      }),
      timeoutMs: options.timeoutMs ?? 10_000,
    })
    const hasItems = parsed.lanes.some(
      (lane) => lane._tag === "available" && lane.items.length > 0,
    )
    const contextText = hasItems ? formatRecallText(parsed, { maxItemsPerLane: limit }) : ""

    await emitTelemetry({
      level: "info",
      source: "worker",
      component: "memory-context-prefetch",
      action: "memory.context_prefetch.completed",
      success: true,
      duration_ms: Date.now() - startedAt,
      metadata: {
        ...metadata,
        lanes: parsed.lanes.map((lane) => ({
          laneName: lane.name,
          healthStatus: lane._tag === "available" ? lane.health : "Unavailable",
          itemCount: lane._tag === "available" ? lane.items.length : 0,
          source: lane.source,
        })),
      },
    }).catch(() => undefined)

    return contextText
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code
        : "RECALL_PREFETCH_FAILED"
    await emitTelemetry({
      level: "error",
      source: "worker",
      component: "memory-context-prefetch",
      action: "memory.context_prefetch.failed",
      success: false,
      error: code,
      duration_ms: Date.now() - startedAt,
      metadata,
    }).catch(() => undefined)
    // Recall is optional enrichment. Missing CLI/store/lane health is visible
    // in redacted telemetry but must not fail the primary Inngest work.
    return ""
  }
}
