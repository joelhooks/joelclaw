import type { ErrorCode } from "./error-codes"

export type RunbookPhase = "diagnose" | "fix" | "verify" | "rollback"

export interface RunbookCommand {
  readonly command: string
  readonly description: string
  readonly destructive?: boolean
}

export interface ErrorRunbook {
  readonly code: ErrorCode
  readonly title: string
  readonly summary: string
  readonly severity: "low" | "medium" | "high"
  readonly phases: Record<RunbookPhase, readonly RunbookCommand[]>
}

const RUNBOOK_LIST: readonly ErrorRunbook[] = [
  {
    code: "INVALID_JSON",
    title: "Invalid JSON payload",
    summary: "Caller payload failed JSON parsing before dispatch.",
    severity: "low",
    phases: {
      diagnose: [
        { command: "joelclaw capabilities", description: "Inspect command templates and expected parameter shapes" },
      ],
      fix: [
        { command: "joelclaw send <event> --data '{}'", description: "Retry with valid JSON payload" },
      ],
      verify: [
        { command: "joelclaw runs --count 5 --hours 1", description: "Confirm event dispatch resumed" },
      ],
      rollback: [
        { command: "joelclaw status", description: "Re-check system health if payload retries keep failing" },
      ],
    },
  },
  {
    code: "INVALID_COLLECTION",
    title: "Unsupported search collection",
    summary: "Collection argument is outside the supported Typesense collection set.",
    severity: "low",
    phases: {
      diagnose: [
        { command: "joelclaw capabilities", description: "Inspect known search and observability command flows" },
      ],
      fix: [
        { command: "joelclaw search <query> --collection otel_events", description: "Retry with deterministic supported collection" },
      ],
      verify: [
        { command: "joelclaw search <query> --collection otel_events --limit 5", description: "Confirm collection query now succeeds" },
      ],
      rollback: [
        { command: "joelclaw otel search <query> --hours 24", description: "Fallback to otel command surface if search flow still fails" },
      ],
    },
  },
  {
    code: "TYPESENSE_UNREACHABLE",
    title: "Typesense unreachable",
    summary: "Search or memory commands cannot connect to Typesense endpoint.",
    severity: "high",
    phases: {
      diagnose: [
        { command: "joelclaw status", description: "Check overall service health before remediation" },
        { command: "joelclaw otel search 'typesense' --hours 24", description: "Inspect recent Typesense-related failures" },
      ],
      fix: [
        {
          command: "kubectl port-forward -n joelclaw svc/typesense 8108:8108 &",
          description: "Restore local Typesense bridge",
          destructive: true,
        },
      ],
      verify: [
        { command: "joelclaw search 'health' --collection otel_events --limit 3", description: "Verify search path is working" },
      ],
      rollback: [
        { command: "pkill -f 'port-forward -n joelclaw svc/typesense 8108:8108'", description: "Stop temporary port-forward if it caused instability" },
      ],
    },
  },
  {
    code: "SEARCH_FAILED",
    title: "Search execution failed",
    summary: "Search request failed for non-connectivity reasons.",
    severity: "medium",
    phases: {
      diagnose: [
        { command: "joelclaw search <query> --collection otel_events --limit 3", description: "Reproduce failure with a narrow deterministic query" },
        { command: "joelclaw otel search 'search failed' --hours 24", description: "Inspect failure signatures and nearby errors" },
      ],
      fix: [
        { command: "joelclaw search <query> --collection otel_events --limit 5", description: "Retry against known-good collection + pagination path" },
      ],
      verify: [
        { command: "joelclaw search <query> --collection otel_events --limit 5", description: "Confirm search now returns hits or empty result set" },
      ],
      rollback: [
        { command: "joelclaw otel list --hours 1", description: "Fallback to OTEL list while search path is investigated" },
      ],
    },
  },
  {
    code: "OTEL_QUERY_FAILED",
    title: "OTEL query failed",
    summary: "Observability list/search query could not be satisfied.",
    severity: "medium",
    phases: {
      diagnose: [
        { command: "joelclaw status", description: "Check services and worker health" },
      ],
      fix: [
        { command: "joelclaw otel list --hours 1", description: "Retry minimal OTEL list query" },
      ],
      verify: [
        { command: "joelclaw otel stats --hours 24", description: "Confirm aggregate OTEL query works" },
      ],
      rollback: [
        { command: "joelclaw logs errors --lines 80", description: "Inspect worker errors if OTEL remains unavailable" },
      ],
    },
  },
  {
    code: "OTEL_STATS_FAILED",
    title: "OTEL stats failed",
    summary: "Aggregate observability query failed.",
    severity: "medium",
    phases: {
      diagnose: [
        { command: "joelclaw otel list --hours 1", description: "Check if base event query path works" },
      ],
      fix: [
        { command: "joelclaw otel stats --hours 24", description: "Retry stats query with default window" },
      ],
      verify: [
        { command: "joelclaw otel search 'error' --hours 24", description: "Confirm query path is fully recovered" },
      ],
      rollback: [
        { command: "joelclaw status", description: "Re-check service health and route to infra triage if needed" },
      ],
    },
  },
  {
    code: "REDIS_CONNECT_FAILED",
    title: "Redis connection failed",
    summary: "CLI stream or gateway command could not connect to Redis.",
    severity: "high",
    phases: {
      diagnose: [
        { command: "joelclaw status", description: "Check Redis pod/service state" },
        { command: "joelclaw logs errors --lines 120", description: "Inspect worker Redis connectivity errors" },
      ],
      fix: [
        { command: "joelclaw gateway restart", description: "Restart gateway daemon and bridge", destructive: true },
      ],
      verify: [
        { command: "joelclaw gateway status", description: "Confirm gateway bridge recovered" },
      ],
      rollback: [
        {
          command: "kubectl rollout restart statefulset/redis -n joelclaw",
          description: "Restart Redis StatefulSet when gateway restart is insufficient",
          destructive: true,
        },
      ],
    },
  },
  {
    code: "REDIS_SUBSCRIBE_FAILED",
    title: "Redis subscription failed",
    summary: "NDJSON stream command could connect but failed subscription.",
    severity: "medium",
    phases: {
      diagnose: [
        { command: "joelclaw gateway status", description: "Check gateway and queue health" },
      ],
      fix: [
        { command: "joelclaw gateway restart", description: "Restart gateway daemon and stream bridge", destructive: true },
      ],
      verify: [
        { command: "joelclaw gateway stream --timeout 10", description: "Verify stream subscription path works" },
      ],
      rollback: [
        { command: "joelclaw status", description: "Escalate to wider health triage if subscription still fails" },
      ],
    },
  },
  {
    code: "RUN_FAILED",
    title: "Inngest run failed",
    summary: "Triggered run ended in FAILED status.",
    severity: "high",
    phases: {
      diagnose: [
        { command: "joelclaw run <run-id>", description: "Inspect failed run trace and output" },
        { command: "joelclaw logs errors --lines 120", description: "Inspect worker stderr around the run window" },
      ],
      fix: [
        { command: "joelclaw inngest sync-worker --restart", description: "Enforce single-source binding, restart, and re-register worker", destructive: true }
      ],
      verify: [
        { command: "joelclaw runs --status FAILED --count 5 --hours 1", description: "Confirm failure rate has dropped" },
      ],
      rollback: [
        { command: "joelclaw refresh", description: "Fallback full worker registration refresh", destructive: true },
      ],
    },
  },
  {
    code: "NO_ACTIVE_LOOP",
    title: "No active loop",
    summary: "Loop watch/operations requested without active loop context.",
    severity: "low",
    phases: {
      diagnose: [
        { command: "joelclaw loop list", description: "List known loops and current status" },
      ],
      fix: [
        { command: "joelclaw loop status", description: "Inspect active loop or confirm no-op state" },
      ],
      verify: [
        { command: "joelclaw loop list", description: "Ensure loop inventory is visible" },
      ],
      rollback: [
        { command: "joelclaw watch", description: "Fallback to auto-detected watch mode" },
      ],
    },
  },
  {
    code: "LOG_MISSING",
    title: "Expected log file missing",
    summary: "Requested local log path does not exist.",
    severity: "low",
    phases: {
      diagnose: [
        { command: "joelclaw status", description: "Check worker and gateway state" },
      ],
      fix: [
        { command: "joelclaw logs worker --lines 80", description: "Recreate/access current worker log stream" },
      ],
      verify: [
        { command: "joelclaw logs errors --lines 40", description: "Confirm error log command path works" },
      ],
      rollback: [
        { command: "joelclaw logs server --lines 80", description: "Fallback to server logs while worker file path is restored" },
      ],
    },
  },
  {
    code: "K8S_UNREACHABLE",
    title: "Kubernetes unreachable",
    summary: "Kubernetes API or logs endpoint could not be reached.",
    severity: "high",
    phases: {
      diagnose: [
        { command: "joelclaw status", description: "Verify cluster-backed service reachability from CLI" },
      ],
      fix: [
        { command: "joelclaw inngest status", description: "Trigger targeted Inngest health probe" },
      ],
      verify: [
        { command: "joelclaw logs server --lines 40", description: "Confirm k8s-backed logs are available again" },
      ],
      rollback: [
        { command: "joelclaw logs worker --lines 40", description: "Fallback to local worker logs if k8s logs remain down" },
      ],
    },
  },
  {
    code: "MEMORY_E2E_FAILED",
    title: "Memory end-to-end check failed",
    summary: "Synthetic memory E2E verification did not complete successfully.",
    severity: "medium",
    phases: {
      diagnose: [
        { command: "joelclaw inngest memory-e2e", description: "Reproduce memory E2E failure" },
      ],
      fix: [
        { command: "joelclaw inngest memory-schema-reconcile", description: "Reconcile memory schema/index state" },
      ],
      verify: [
        { command: "joelclaw inngest memory-e2e", description: "Re-run E2E verification" },
      ],
      rollback: [
        { command: "joelclaw inngest memory-health", description: "Fallback to baseline memory health probe" },
      ],
    },
  },
  {
    code: "MEMORY_WEEKLY_FAILED",
    title: "Memory weekly job failed",
    summary: "Weekly memory maintenance check did not complete.",
    severity: "medium",
    phases: {
      diagnose: [
        { command: "joelclaw inngest memory-weekly", description: "Reproduce weekly memory workflow failure" },
      ],
      fix: [
        { command: "joelclaw inngest memory-schema-reconcile", description: "Repair schema/index drift before retry" },
      ],
      verify: [
        { command: "joelclaw inngest memory-weekly", description: "Re-run weekly memory workflow" },
      ],
      rollback: [
        { command: "joelclaw inngest memory-health", description: "Fallback to memory health check while weekly flow is triaged" },
      ],
    },
  },
  {
    code: "MEMORY_HEALTH_FAILED",
    title: "Memory health failed",
    summary: "Memory subsystem health checks did not pass.",
    severity: "high",
    phases: {
      diagnose: [
        { command: "joelclaw inngest memory-health", description: "Collect failing health checks and details" },
        { command: "joelclaw otel search 'memory' --hours 24", description: "Inspect recent memory-related telemetry errors" },
      ],
      fix: [
        { command: "joelclaw inngest memory-schema-reconcile", description: "Attempt automated memory schema repair" },
      ],
      verify: [
        { command: "joelclaw inngest memory-health", description: "Confirm memory health checks pass" },
      ],
      rollback: [
        { command: "joelclaw inngest sync-worker --restart", description: "Enforce single-source binding and restart worker if memory handlers are stuck", destructive: true }
      ],
    },
  },
  {
    code: "MEMORY_SCHEMA_RECONCILE_FAILED",
    title: "Memory schema reconciliation failed",
    summary: "Schema reconciliation encountered unrecoverable errors.",
    severity: "high",
    phases: {
      diagnose: [
        { command: "joelclaw inngest memory-schema-reconcile", description: "Reproduce reconciliation failure details" },
      ],
      fix: [
        { command: "joelclaw inngest memory-health", description: "Run health check to rehydrate baseline schema state" },
      ],
      verify: [
        { command: "joelclaw inngest memory-e2e", description: "Confirm end-to-end memory pipeline health" },
      ],
      rollback: [
        { command: "joelclaw logs errors --lines 120 --grep memory", description: "Capture memory-specific errors for manual rollback plan" },
      ],
    },
  },
  {
    code: "APPROVAL_APPROVE_FAILED",
    title: "Approval action failed",
    summary: "Approving a queued operation failed.",
    severity: "medium",
    phases: {
      diagnose: [
        { command: "joelclaw approvals list --status pending", description: "Inspect pending approval backlog" },
      ],
      fix: [
        { command: "joelclaw approvals approve <id> --reviewer <name>", description: "Retry approve action with explicit reviewer" },
      ],
      verify: [
        { command: "joelclaw approvals history --limit 5", description: "Confirm approval event is recorded" },
      ],
      rollback: [
        { command: "joelclaw approvals deny <id> --reason <reason>", description: "Fallback to deny flow if approval remains blocked" },
      ],
    },
  },
  {
    code: "APPROVAL_DENY_FAILED",
    title: "Approval deny action failed",
    summary: "Denying a queued operation failed.",
    severity: "medium",
    phases: {
      diagnose: [
        { command: "joelclaw approvals list --status pending", description: "Inspect pending approval backlog" },
      ],
      fix: [
        { command: "joelclaw approvals deny <id> --reason <reason>", description: "Retry deny action with explicit reason" },
      ],
      verify: [
        { command: "joelclaw approvals history --limit 5", description: "Confirm deny event is recorded" },
      ],
      rollback: [
        { command: "joelclaw approvals approve <id> --reviewer <name>", description: "Fallback to approval flow if deny path remains blocked" },
      ],
    },
  },
  {
    code: "MISSING_MESSAGE",
    title: "Missing required message",
    summary: "Required message argument was empty or omitted.",
    severity: "low",
    phases: {
      diagnose: [
        { command: "joelclaw capabilities", description: "Inspect command usage and required positional arguments" },
      ],
      fix: [
        { command: "joelclaw call <message>", description: "Retry command with explicit message text" },
      ],
      verify: [
        { command: "joelclaw runs --count 5 --hours 1", description: "Confirm call workflow was accepted" },
      ],
      rollback: [
        { command: "joelclaw status", description: "Check system readiness if valid messages still fail" },
      ],
    },
  },
  {
    code: "SEMANTIC_SEARCH_FAILED",
    title: "Semantic search failed",
    summary: "Embedding-backed semantic search path failed.",
    severity: "medium",
    phases: {
      diagnose: [
        { command: "joelclaw vault search <query> --section notes", description: "Reproduce semantic search failure with bounded scope" },
      ],
      fix: [
        { command: "joelclaw vault search <query> --regex", description: "Fallback to deterministic regex search mode" },
      ],
      verify: [
        { command: "joelclaw vault search <query> --section notes", description: "Confirm semantic path recovered after fallback" },
      ],
      rollback: [
        { command: "joelclaw search <query> --collection otel_events --limit 5", description: "Use OTEL search while vault semantic path is repaired" },
      ],
    },
  },
]

export const RUNBOOKS: Record<string, ErrorRunbook> = Object.fromEntries(
  RUNBOOK_LIST.map((runbook) => [runbook.code, runbook])
)

export function getRunbook(code: string): ErrorRunbook | null {
  return RUNBOOKS[code] ?? null
}

export function listRunbookCodes(): readonly string[] {
  return RUNBOOK_LIST.map((runbook) => runbook.code)
}

function resolvePlaceholder(
  placeholder: string,
  context: Record<string, unknown>
): string {
  const raw = context[placeholder]
  if (raw == null) return `<${placeholder}>`
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
    return String(raw)
  }
  return JSON.stringify(raw)
}

export function resolveRunbookCommand(
  command: string,
  context: Record<string, unknown>
): string {
  return command.replace(/<([a-zA-Z0-9_-]+)>/g, (_match, key: string) =>
    resolvePlaceholder(key, context)
  )
}

export function resolveRunbookPhase(
  runbook: ErrorRunbook,
  phase: RunbookPhase,
  context: Record<string, unknown>
): readonly (RunbookCommand & { resolvedCommand: string })[] {
  return runbook.phases[phase].map((entry) => ({
    ...entry,
    resolvedCommand: resolveRunbookCommand(entry.command, context),
  }))
}
