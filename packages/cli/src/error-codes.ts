export const ERROR_CODES = [
  "INVALID_JSON",
  "INVALID_COLLECTION",
  "TYPESENSE_UNREACHABLE",
  "SEARCH_FAILED",
  "OTEL_QUERY_FAILED",
  "OTEL_STATS_FAILED",
  "REDIS_CONNECT_FAILED",
  "REDIS_SUBSCRIBE_FAILED",
  "RUN_FAILED",
  "NO_ACTIVE_LOOP",
  "LOG_MISSING",
  "K8S_UNREACHABLE",
  "MEMORY_E2E_FAILED",
  "MEMORY_WEEKLY_FAILED",
  "MEMORY_HEALTH_FAILED",
  "MEMORY_SCHEMA_RECONCILE_FAILED",
  "APPROVAL_APPROVE_FAILED",
  "APPROVAL_DENY_FAILED",
  "MISSING_MESSAGE",
  "SEMANTIC_SEARCH_FAILED",
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export function isErrorCode(value: string): value is ErrorCode {
  return (ERROR_CODES as readonly string[]).includes(value)
}

export function normalizeErrorCode(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_")
}
