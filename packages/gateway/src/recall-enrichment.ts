import {
  createComposedRecallRequest,
  formatRecallText,
  type ParsedComposedRecall,
  runComposedRecallCli,
} from "@joelclaw/recall"
import { emitGatewayOtel } from "@joelclaw/telemetry"

export const GATEWAY_RECALL_UNAVAILABLE_MARKER =
  "Recall unavailable for this prompt. Continue without memory context."

export const DISCORD_PUBLIC_RECALL_POLICY = {
  scope: { project: "joelclaw-fleet", workstream: "default" },
  access: {
    principalRef: "service:discord-recall",
    purpose: "discord-public-recall",
    allowedPrivacy: ["public"],
  },
} as const

type GatewayRecallDependencies = {
  readonly runRecall?: typeof runComposedRecallCli
  readonly emitTelemetry?: typeof emitGatewayOtel
}

function hasItems(parsed: ParsedComposedRecall): boolean {
  return parsed.lanes.some((lane) => lane._tag === "available" && lane.items.length > 0)
}

export async function buildGatewayRecallSection(
  message: string,
  dependencies: GatewayRecallDependencies = {},
): Promise<string> {
  try {
    const parsed = await (dependencies.runRecall ?? runComposedRecallCli)({
      request: createComposedRecallRequest({
        query: message,
        scope: { project: "joelclaw-fleet", workstream: "default" },
        access: {
          principalRef: "service:gateway",
          purpose: "gateway-prompt-enrichment",
          allowedPrivacy: ["public", "private"],
        },
        limits: { curated: 3, observations: 3, reflections: 3 },
      }),
      timeoutMs: 5_000,
    })
    if (!hasItems(parsed)) return ""
    return `Relevant memory by lane:\n${formatRecallText(parsed, { maxItemsPerLane: 3 })}`
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code
        : "GATEWAY_RECALL_FAILED"
    await Promise.resolve(
      (dependencies.emitTelemetry ?? emitGatewayOtel)({
        level: "warn",
        component: "redis-channel",
        action: "memory.recall.failed",
        success: false,
        error: code,
        metadata: { principalClass: "service" },
      }),
    ).catch(() => undefined)
    return GATEWAY_RECALL_UNAVAILABLE_MARKER
  }
}
