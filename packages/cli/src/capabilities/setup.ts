import { gatewayRedisNotifyAdapter } from "./adapters/gateway-redis"
import { secretsCliAdapter } from "./adapters/secrets-cli"
import { slogCliAdapter } from "./adapters/slog-cli"
import { createCapabilityRegistry } from "./registry"

export const capabilityRegistry = createCapabilityRegistry()
  .register(secretsCliAdapter)
  .register(slogCliAdapter)
  .register(gatewayRedisNotifyAdapter)
