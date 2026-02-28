# ADR-0169: CLI Capability Interface Contracts

**Status:** proposed  
**Date:** 2026-02-28  
**Deciders:** Joel Hooks  
**Supersedes:** None  
**Related:** ADR-0144 (hexagonal architecture), ADR-0163 (adaptive prompt architecture)

## Context

SYSTEM.md defines system capabilities as `joelclaw` CLI commands: `otel`, `recall`, `mail`, `secrets`, `deploy`, `notify`, `heal`, `log`. These are the platform's operational surface — every agent interacts with the system through them.

Currently these commands are implemented ad-hoc. Some exist (`otel`, `recall`, `secrets`, `subscribe`), some are planned (`mail`, `deploy`, `notify`, `heal`, `log`). There's no formal interface contract defining what each capability accepts, returns, or how its backing adapter is configured.

As the system grows — and as we build pi extension tools that shell to `joelclaw` under the hood — we need each capability to be a well-defined port with swappable adapters.

## Decision

### Each capability is a port

Every `joelclaw <capability>` command defines:

1. **Interface contract** — TypeScript interface in `@joelclaw/cli` specifying input schema, output schema, and HATEOAS envelope shape
2. **Default adapter** — the concrete implementation (e.g., `mail` → mcp_agent_mail HTTP, `secrets` → agent-secrets daemon, `otel` → Typesense)
3. **Configuration** — adapter selection and config in `~/.joelclaw/config.toml` or `.joelclaw/config.toml` per-project

### Contract structure

```typescript
interface CapabilityPort<TInput, TOutput> {
  name: string;
  subcommands: string[];
  execute(subcommand: string, input: TInput): Promise<HateoasEnvelope<TOutput>>;
}
```

### Adapter configuration

```toml
# ~/.joelclaw/config.toml

[capabilities.mail]
adapter = "mcp-agent-mail"  # default
endpoint = "http://127.0.0.1:8765"

[capabilities.secrets]
adapter = "agent-secrets"  # default
# future: adapter = "1password-cli"

[capabilities.otel]
adapter = "typesense"  # default
collection = "otel_events"

[capabilities.deploy]
adapter = "k8s-script"  # default
script = "k8s/publish-system-bus-worker.sh"
```

### Capabilities inventory

| Capability | Status | Default Adapter | Port Interface |
|-----------|--------|----------------|----------------|
| `otel` | ✅ exists | Typesense | query, search, stats |
| `recall` | ✅ exists | Typesense | semantic search |
| `secrets` | ✅ exists | agent-secrets daemon | lease, status, revoke |
| `mail` | 🔨 build | mcp_agent_mail (MCP HTTP) | send, read, reserve, release, register |
| `deploy` | 🔨 build | k8s deploy scripts | worker, web, cli |
| `notify` | 🔨 build | gateway Redis bridge | push message to channel |
| `heal` | 🔨 build | self-heal engine | detect, fix, revert, notify |
| `log` | 🔨 build | slog CLI wrapper | write structured entry |
| `subscribe` | ✅ exists | Typesense | list, add, remove, check |

### Evolution toward AT Protocol

The `mail` capability is designed with adapter swappability specifically because it will evolve from mcp_agent_mail → AT Protocol PDS-backed communication. The port interface stays stable; only the adapter changes:

```toml
# future
[capabilities.mail]
adapter = "atproto-pds"
pds_endpoint = "http://localhost:3000"
lexicon = "dev.joelclaw.agent.mail"
```

### Pi extension tools

Each capability becomes a registered pi tool via the joelclaw pi extension. The tool shells to `joelclaw <capability> <subcommand>` and returns the HATEOAS JSON envelope.

```typescript
pi.registerTool({
  name: "mail",
  description: "Send and receive agent mail. Reserve files, communicate tasks.",
  params: Type.Object({
    subcommand: Type.Union([
      Type.Literal("send"), Type.Literal("read"),
      Type.Literal("reserve"), Type.Literal("release")
    ]),
    args: Type.Record(Type.String(), Type.String())
  }),
  execute: async ({ subcommand, args }) => {
    return execSync(`joelclaw mail ${subcommand} ${formatArgs(args)}`);
  }
});
```

## Consequences

- Every capability has a testable interface contract
- Adapters are swappable without changing agent behavior
- `.joelclaw/config.toml` becomes the single configuration surface
- Pi extension tools are thin wrappers, not reimplementations
- AT Proto migration path is built into the architecture from day one
- New capabilities follow a consistent pattern: define port → implement adapter → register tool → document in SYSTEM.md
