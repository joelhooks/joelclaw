---
description: Generate a daily system activity summary across all joelclaw subsystems. Triggers on 'daily summary', 'what happened today', 'system report', 'today's tally', 'activity summary', 'what did we do', 'daily report'.
---

# Daily Summary

Generate a comprehensive daily activity report across all joelclaw subsystems.

## Data Sources

Collect from ALL of these:

### 1. Git commits
```bash
# joelclaw repo
cd ~/Code/joelhooks/joelclaw && git log --oneline --since="$(date +%Y-%m-%d)T00:00:00" --no-merges

# Vault
cd ~/Vault && git log --oneline --since="$(date +%Y-%m-%d)T00:00:00" --no-merges
```

### 2. Inngest runs
```bash
joelclaw runs --count 200 --hours 24
```
Summarize: total, completed, failed, unique functions. Flag any failures.

### 3. K8s cluster state
```bash
kubectl get pods -n joelclaw --no-headers
```
Note any new deployments, restarts, or unhealthy pods.

### 4. Codex sessions
Count sessions created today. Note which were gateway-dispatched vs standalone.

### 5. OTEL events
```bash
joelclaw otel stats --hours 24
```

### 6. ADR changes
```bash
cd ~/Vault/docs/decisions && git log --oneline --since="$(date +%Y-%m-%d)T00:00:00" --no-merges -- .
```
Count: new ADRs, status changes, grooming activity.

### 7. Discoveries
Check for discovery/noted events in recent Inngest runs.

### 8. Memory observations
```bash
joelclaw otel search "observe" --hours 24
```

### 9. Worker deploys
Check slog for deploy actions today:
```bash
slog tail --count 20 | grep -i deploy
```

### 10. System changes
Check slog for configure/install actions:
```bash
slog tail --count 20
```

## Output Format

Concise, structured. Group by category:
- **Code** — commit count + highlights per repo
- **Infrastructure** — deploys, new services, config changes
- **Inngest** — run stats, failure rate
- **Agents** — codex sessions, pi sessions
- **ADRs** — new, groomed, status changes
- **Knowledge** — discoveries, memory observations
- **K8s** — cluster health, new pods

For Telegram: use HTML tags, keep mobile-friendly.
For CLI: return HATEOAS JSON with `summary` object.
