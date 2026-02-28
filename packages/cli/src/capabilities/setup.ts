import { scriptedDeployAdapter } from "./adapters/deploy-scripted"
import { gatewayRedisNotifyAdapter } from "./adapters/gateway-redis"
import { runbookHealAdapter } from "./adapters/heal-runbook"
import { mcpAgentMailAdapter } from "./adapters/mcp-agent-mail"
import { redisSubscriptionsAdapter } from "./adapters/redis-subscriptions"
import { secretsCliAdapter } from "./adapters/secrets-cli"
import { slogCliAdapter } from "./adapters/slog-cli"
import { typesenseOtelAdapter } from "./adapters/typesense-otel"
import { typesenseRecallAdapter } from "./adapters/typesense-recall"
import { createCapabilityRegistry } from "./registry"

export const capabilityRegistry = createCapabilityRegistry()
  .register(secretsCliAdapter)
  .register(slogCliAdapter)
  .register(typesenseOtelAdapter)
  .register(typesenseRecallAdapter)
  .register(mcpAgentMailAdapter)
  .register(redisSubscriptionsAdapter)
  .register(scriptedDeployAdapter)
  .register(runbookHealAdapter)
  .register(gatewayRedisNotifyAdapter)
