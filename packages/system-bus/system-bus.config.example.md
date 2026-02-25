# `system-bus.config.json` template

Copy this content to `~/.joelclaw/system-bus.config.json` and tune only the values you need.
Environment variables always override file values at runtime.

```json
{
  "selfHealing": {
    "router": {
      "model": "gpt-5.2-codex-spark",
      "fallbackModel": "gpt-5.3-codex",
      "maxRetries": 5,
      "sleepMinMs": 300000,
      "sleepMaxMs": 14400000,
      "sleepStepMs": 30000
    },
    "transport": {
      "nasRecoveryWindowHours": 4,
      "nasMaxAttempts": 12,
      "nasRetryBaseMs": 10000,
      "nasRetryMaxMs": 120000,
      "nasSshHost": "joel@three-body",
      "nasSshFlags": "-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=2",
      "nasHddRoot": "/Volumes/three-body",
      "nasNvmeRoot": "/Volumes/nas-nvme"
    }
  },
  "backupFailureRouter": {
    "model": "gpt-5.2-codex-spark",
    "fallbackModel": "gpt-5.3-codex",
    "maxRetries": 5,
    "sleepMinMs": 300000,
    "sleepMaxMs": 14400000,
    "sleepStepMs": 30000
  },
  "backupTransport": {
    "nasRecoveryWindowHours": 4,
    "nasMaxAttempts": 12,
    "nasRetryBaseMs": 10000,
    "nasRetryMaxMs": 120000,
    "nasSshHost": "joel@three-body",
    "nasSshFlags": "-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=2",
    "nasHddRoot": "/Volumes/three-body",
    "nasNvmeRoot": "/Volumes/nas-nvme"
  }
}
```

## Key semantics

### `selfHealing`

Global self-healing configuration used by structured remediation flows.

- `router.model`: primary model for self-healing decisioning.
- `router.fallbackModel`: fallback model if primary fails for a decision.
- `router.maxRetries`: max decision attempts before escalation.
- `router.sleepMinMs`: lower bound for retry sleep.
- `router.sleepMaxMs`: upper bound for retry sleep.
- `router.sleepStepMs`: jitter window used in dynamic sleep calculation.
- `transport`: shared transport knobs (shared with backup-heavy remediation paths).

### `backupFailureRouter`

- `model`: primary model for the failure-routing LLM decision.
- `fallbackModel`: used if the primary model fails for this decision.
- `maxRetries`: max router retries for the failure routing loop.
- `sleepMinMs`: lower bound for dynamic retry sleeps.
- `sleepMaxMs`: upper bound for dynamic retry sleeps.
- `sleepStepMs`: jitter window for backoff calculation.

### `backupTransport`

- `nasRecoveryWindowHours`: recovery window before non-retry escalation.
- `nasMaxAttempts`: per-transport attempt limit for copy/fallback operations.
- `nasRetryBaseMs`: transport retry base delay.
- `nasRetryMaxMs`: cap for transport retries.
- `nasSshHost`: SSH destination for remote NAS copy fallback.
- `nasSshFlags`: SSH flags used for remote copy checks and scp commands.
- `nasHddRoot`: HDD mount root path used for colder archival backup destinations.
- `nasNvmeRoot`: NVMe mount root path used for warm/shared backup destinations.

## Environment override equivalents

- `SELF_HEALING_ROUTER_MODEL`
- `SELF_HEALING_ROUTER_FALLBACK_MODEL`
- `SELF_HEALING_ROUTER_MAX_RETRIES`
- `SELF_HEALING_ROUTER_SLEEP_MIN_MS`
- `SELF_HEALING_ROUTER_SLEEP_MAX_MS`
- `SELF_HEALING_ROUTER_SLEEP_STEP_MS`
- `SELF_HEALING_RECOVERY_WINDOW_HOURS`
- `SELF_HEALING_MAX_ATTEMPTS`
- `SELF_HEALING_RETRY_BASE_MS`
- `SELF_HEALING_RETRY_MAX_MS`
- `SELF_HEALING_NAS_HOST`
- `SELF_HEALING_NAS_FLAGS`
- `SELF_HEALING_NAS_HDD_ROOT`
- `SELF_HEALING_NAS_NVME_ROOT`

- `BACKUP_FAILURE_ROUTER_MODEL`
- `BACKUP_FAILURE_ROUTER_FALLBACK_MODEL`
- `BACKUP_ROUTER_MAX_RETRIES`
- `BACKUP_ROUTER_SLEEP_MIN_MS`
- `BACKUP_ROUTER_SLEEP_MAX_MS`
- `BACKUP_ROUTER_SLEEP_STEP_MS`
- `NAS_BACKUP_RECOVERY_WINDOW_HOURS`
- `NAS_BACKUP_MAX_ATTEMPTS`
- `NAS_BACKUP_RETRY_BASE_MS`
- `NAS_BACKUP_RETRY_MAX_MS`
- `NAS_SSH_HOST`
- `NAS_SSH_FLAGS`
- `NAS_HDD_ROOT`
- `NAS_NVME_ROOT`
