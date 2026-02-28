import { scriptedDeployAdapter } from "./adapters/deploy-scripted"
import { gatewayRedisNotifyAdapter } from "./adapters/gateway-redis"
import { runbookHealAdapter } from "./adapters/heal-runbook"
import { secretsCliAdapter } from "./adapters/secrets-cli"
import { slogCliAdapter } from "./adapters/slog-cli"
import { createCapabilityRegistry } from "./registry"

export const capabilityRegistry = createCapabilityRegistry()
  .register(secretsCliAdapter)
  .register(slogCliAdapter)
  .register(scriptedDeployAdapter)
  .register(runbookHealAdapter)
  .register(gatewayRedisNotifyAdapter)
