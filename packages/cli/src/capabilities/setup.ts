import { clickhouseOtelAdapter } from "./adapters/clickhouse-otel"
import { scriptedDeployAdapter } from "./adapters/deploy-scripted"
import { flowingMemoryRecallAdapter } from "./adapters/flowing-memory-recall"
import { gatewayRedisNotifyAdapter } from "./adapters/gateway-redis"
import { runbookHealAdapter } from "./adapters/heal-runbook"
import { mcpAgentMailAdapter } from "./adapters/mcp-agent-mail"
import { redisSubscriptionsAdapter } from "./adapters/redis-subscriptions"
import { secretsCliAdapter } from "./adapters/secrets-cli"
import { typesenseOtelAdapter } from "./adapters/typesense-otel"
import { typesenseRecallAdapter } from "./adapters/typesense-recall"
import { createCapabilityRegistry } from "./registry"

export const capabilityRegistry = createCapabilityRegistry()
  .register(secretsCliAdapter)
  .register(clickhouseOtelAdapter)
  .register(typesenseOtelAdapter)
  .register(typesenseRecallAdapter)
  // Registered, never default. `DEFAULT_CAPABILITY_CONFIG.recall.adapter` stays `typesense-recall`.
  .register(flowingMemoryRecallAdapter)
  .register(mcpAgentMailAdapter)
  .register(redisSubscriptionsAdapter)
  .register(scriptedDeployAdapter)
  .register(runbookHealAdapter)
  .register(gatewayRedisNotifyAdapter)
