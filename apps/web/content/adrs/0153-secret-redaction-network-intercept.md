---
id: "0153"
title: "Secret Redaction & Network Intercept"
status: "proposed"
date: 2026-02-26
deciders: ["joel", "sean-grove"]
---

# ADR-0153: Secret Redaction & Network Intercept

## Status

Proposed

## Context

The current `agent-secrets` system uses a lease-based model: agents request a secret by name, receive the raw value with a TTL, and use it directly in API calls. This works but has a fundamental weakness — the agent sees and handles the actual secret value. A compromised or misbehaving agent can exfiltrate secrets to unauthorized endpoints.

Deno's sandbox API demonstrates a better pattern: **secret redaction and substitution**. Secrets are declared with approved host scopes. Inside the sandbox, reading the secret returns an opaque placeholder. When the runtime intercepts an outbound request to an approved host, it substitutes the real value into the request headers. The agent never sees the real secret.

```typescript
// Deno's model
await using sandbox = await Sandbox.create({
  secrets: {
    ANTHROPIC_API_KEY: {
      hosts: ["api.anthropic.com"],
      value: process.env.ANTHROPIC_API_KEY,
    },
  },
});
// Agent code reads ANTHROPIC_API_KEY → gets placeholder
// Agent fetches api.anthropic.com → runtime injects real key
// Agent fetches evil.com with the "key" → placeholder sent, useless
```

Sean Grove suggested this approach as a migration path from the current CLI-based secrets to a network-intercept model where agents never see credentials.

## Decision

Migrate `agent-secrets` from lease-based raw value delivery to a network-intercept model:

1. **Secret declarations gain host scoping** — each secret specifies which hosts may receive it
2. **A local proxy intercepts outbound requests** — substitutes real credentials for approved host+secret pairs
3. **Agent env vars contain redacted placeholders** — the proxy recognizes and replaces them
4. **Existing lease API remains as fallback** — for secrets that aren't HTTP-bound (e.g., database connection strings, SSH keys)

## Architecture

### Phase 1: Host-scoped secret declarations

Extend `.secrets.json` schema:

```json
{
  "mux_token_id": {
    "hosts": ["api.mux.com"],
    "header": "Authorization",
    "format": "Basic {mux_token_id}:{mux_token_secret}"
  },
  "anthropic_api_key": {
    "hosts": ["api.anthropic.com"],
    "header": "x-api-key"
  }
}
```

### Phase 2: Local intercept proxy

A lightweight HTTP/HTTPS proxy (Bun or Deno) that:
- Runs on `localhost:$SECRETS_PROXY_PORT`
- Inspects outbound requests for approved host matches
- Injects real credentials from the secrets store
- Passes through everything else unchanged
- Agents use `HTTP_PROXY` / `HTTPS_PROXY` env vars to route through it

### Phase 3: Agent sandbox integration

- Codex sandboxes, Docker containers, and pi sessions configure the proxy automatically
- `secrets_env` generates proxy config instead of raw `.env` values
- Audit log captures which secrets were substituted for which hosts

## Consequences

### Positive
- Agents never see raw secret values — eliminates exfiltration risk
- Host scoping prevents credential misuse (Mux key can't be sent to Anthropic)
- Audit trail captures actual secret usage at the network level
- Compatible with existing `fetch()` / `curl` — no agent code changes needed

### Negative
- Adds a proxy hop to all outbound requests (latency)
- HTTPS interception requires trust configuration (MITM cert or connect-through)
- Database connection strings, SSH keys, and non-HTTP secrets still need the lease model
- More infrastructure to maintain

### Neutral
- Lease API remains for non-HTTP secrets — not a full replacement
- Migration is incremental — both models coexist

## Alternatives Considered

1. **Deno sandbox runtime** — Use Deno's native sandbox API directly. Rejected: ties us to Deno runtime, agents use Bun/Node.
2. **Vault + short-lived tokens** — HashiCorp Vault with dynamic credentials. Rejected: heavy infrastructure for a single-user system.
3. **Keep lease model + audit hardening** — Add exfiltration detection to the existing system. Rejected: detection after the fact is worse than prevention.

## References

- [Deno sandbox secret redaction](https://thenewstack.io/deno-sandbox-security-secrets/) — TheNewStack, Feb 2026
- ADR-0152: Dream Process (related — agent trust boundaries)
- Current `agent-secrets` daemon: `~/.pi/agent/secrets/`
