---
name: langfuse
displayName: Langfuse Observability
description: Instrument joelclaw LLM calls with Langfuse tracing. Covers the @langfuse/tracing SDK, observation hierarchy (spans, generations, tools, agents), propagateAttributes for userId/sessionId/tags, the pi-session extension (langfuse-cost), and the system-bus OTEL integration. Use when adding Langfuse traces, debugging missing/broken traces, checking cost data, or improving observability on any LLM surface.
version: 0.1.0
author: joel
tags:
  - observability
  - langfuse
  - tracing
  - llm
---

# Langfuse Observability

Langfuse is the LLM observability layer for joelclaw. Every LLM call should produce a Langfuse trace with proper hierarchy, I/O, usage, cost, and attribution.

## Architecture

joelclaw has **two Langfuse integration points**:

### 1. Pi-session extension (`langfuse-cost`)
- **Source**: `~/Code/joelhooks/pi-tools/langfuse-cost/index.ts`
- **Symlinked**: `~/.pi/agent/extensions/langfuse-cost` → git cache
- **What it traces**: Every gateway LLM call (Telegram conversations, event handling)
- **How**: Hooks into pi session events (`message_start`, `message_end`, `session_start`, `session_shutdown`)
- **Produces**: `joelclaw.session.call` traces with `session.call` generation children

### 2. System-bus OTEL bridge (`langfuse.ts`)
- **Source**: `packages/system-bus/src/lib/langfuse.ts`
- **What it traces**: All Inngest function LLM calls (reflect, triage, email cleanup, docs ingest)
- **How**: `@langfuse/otel` `LangfuseSpanProcessor` + `@langfuse/tracing` `startObservation()`
- **Produces**: `joelclaw.inference` traces with generation children

## The Right Way: @langfuse/tracing SDK

The Langfuse JS/TS SDK uses OpenTelemetry under the hood. The key APIs:

### Setup (once per process)

```typescript
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { setLangfuseTracerProvider } from "@langfuse/tracing";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

const processor = new LangfuseSpanProcessor({
  publicKey: process.env.LANGFUSE_PUBLIC_KEY,
  secretKey: process.env.LANGFUSE_SECRET_KEY,
  baseUrl: process.env.LANGFUSE_HOST || "https://us.cloud.langfuse.com",
  environment: "production",
  exportMode: "immediate",
});

const provider = new BasicTracerProvider({
  resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: "joelclaw-system-bus" }),
  spanProcessors: [processor],
});

setLangfuseTracerProvider(provider);
```

### Observation Types

Langfuse has a rich type system for observations. Use the right type:

| Type | When | Example |
|------|------|---------|
| `span` | General operations, workflows | `user-request-pipeline` |
| `generation` | LLM calls | `openai-gpt-4`, `claude-opus` |
| `tool` | Tool/function calls | `web-search`, `bash-exec` |
| `agent` | Agent workflows | `research-agent`, `triage-agent` |
| `chain` | Multi-step pipelines | `rag-pipeline`, `docs-ingest` |
| `retriever` | Search/retrieval | `vector-search`, `vault-lookup` |
| `event` | Point-in-time log entries | `user-login`, `error-detected` |

### Creating Observations

```typescript
import { startObservation, startActiveObservation, propagateAttributes } from "@langfuse/tracing";

// Simple trace with generation child
const trace = startObservation("joelclaw.inference", {
  input: userPrompt,
  metadata: { component: "reflect", action: "summarize" },
});

trace.updateTrace({
  name: "joelclaw.inference",
  userId: "joel",
  sessionId: sessionId,
  tags: ["joelclaw", "system-bus", `model:${model}`, `provider:${provider}`],
});

const generation = trace.startObservation("llm-call", {
  model: "claude-haiku-4-5",
  input: userPrompt,
  output: responseText,
  usageDetails: { input: 100, output: 50, total: 150 },
  costDetails: { input: 0.001, output: 0.002, total: 0.003 },
}, { asType: "generation" });

generation.end();
trace.update({ output: responseText });
trace.end();
```

### Context Manager Pattern (preferred for complex flows)

```typescript
await startActiveObservation("docs-ingest-pipeline", async (span) => {
  span.update({ input: { docId, source } });

  await propagateAttributes({
    userId: "joel",
    sessionId: runId,
    tags: ["joelclaw", "docs-ingest"],
    metadata: { pipeline: "docs-ingest", env: "production" },
  }, async () => {
    // All child observations inherit userId, sessionId, tags
    const chunks = await startActiveObservation("chunk-document", async (retriever) => {
      retriever.update({ input: { docId } });
      const result = await chunkDoc(docId);
      retriever.update({ output: { chunkCount: result.length } });
      return result;
    }, { asType: "retriever" });

    await startActiveObservation("classify-taxonomy", async (gen) => {
      gen.update({ input: chunks, model: "claude-haiku-4-5" });
      const taxonomy = await classifyWithLLM(chunks);
      gen.update({
        output: taxonomy,
        usageDetails: { input: 500, output: 100, total: 600 },
      });
      return taxonomy;
    }, { asType: "generation" });
  });

  span.update({ output: { status: "complete" } });
});
```

### The `observe` Decorator (for wrapping existing functions)

```typescript
import { observe } from "@langfuse/tracing";

const classifyEmail = observe(
  async (email: string) => {
    const result = await infer({ prompt: email, model: "claude-haiku-4-5" });
    return result;
  },
  {
    name: "classify-email",
    asType: "generation",
    captureInput: true,
    captureOutput: true,
  }
);
```

## Attribute Propagation

`propagateAttributes()` is the key to good traces. Call it early in your trace:

```typescript
await propagateAttributes({
  userId: "joel",                    // Required — enables user analytics
  sessionId: "session-abc",          // Groups multi-turn conversations
  tags: ["joelclaw", "system-bus"],  // Filterable in UI
  metadata: { component: "reflect" }, // Flat keys only, filterable
  version: "1.0",                    // Track deployments
  traceName: "joelclaw.inference",   // Override trace name
}, async () => {
  // ALL child observations inherit these attributes
});
```

**Rules for propagateAttributes:**
- Values must be **strings ≤200 characters**
- Metadata keys: **alphanumeric only** (no whitespace/special chars)
- Call **early** in trace — observations created before propagation miss attributes
- Tags are **string arrays**, each tag ≤200 chars

## joelclaw Trace Conventions

### Naming
- Pi-session: `joelclaw.session.call`
- System-bus: `joelclaw.inference`
- Future: `joelclaw.docs.*`, `joelclaw.email.*`, etc.

### Required Attributes
Every trace MUST have:
- `userId: "joel"` — all traces are Joel's
- `sessionId` — group related traces
- `tags` — minimum: `["joelclaw", "<source>"]` where source is `pi-session`, `system-bus`, etc.
- Dynamic tags: `provider:<name>`, `model:<name>`, `channel:<name>`

### Metadata Shape (flat, filterable)
```typescript
{
  source: "system-bus",
  component: "reflect",      // Which module
  action: "summarize",       // What operation
  provider: "anthropic",
  model: "claude-haiku-4-5",
  durationMs: 1234,
  task: "summary",           // Semantic task type
  agentProfile: "reflector", // ADR-0147 profile name
  error: "rate_limit",       // Only on failure
}
```

**Never nest objects in metadata** — only top-level keys are filterable in Langfuse.

### Generation Attributes
```typescript
{
  model: "claude-haiku-4-5",
  usageDetails: {
    input: 100,
    output: 50,
    total: 150,
    cache_read_input_tokens: 80,   // OpenAI-compatible key names
    cache_write_input_tokens: 20,
  },
  costDetails: {
    input: 0.001,
    output: 0.002,
    total: 0.003,
  },
  completionStartTime: new Date(), // TTFT
}
```

## Credentials

Langfuse creds are in `agent-secrets`:
- `langfuse_public_key`
- `langfuse_secret_key`
- `langfuse_base_url` (defaults to `https://us.cloud.langfuse.com`)

Gateway gets them via `gateway-start.sh` exports. System-bus resolves them via env → `secrets lease` fallback.

**Gateway also needs `GATEWAY_ROLE=central`** in `gateway-start.sh` for correct `channel:central` tags.

## Vercel AI SDK Integration

If using Vercel AI SDK (`generateText`, `streamText`), integration is automatic:

```typescript
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

const { text } = await generateText({
  model: openai("gpt-4"),
  prompt: "Hello",
  experimental_telemetry: {
    isEnabled: true,
    functionId: "my-function",
    metadata: {
      langfuseTraceId: parentTraceId,     // Link to existing trace
      langfuseUpdateParent: false,         // Don't overwrite parent
    },
  },
});
```

The AI SDK automatically creates spans for model calls, tool executions, etc. The `LangfuseSpanProcessor` intercepts them. This produces the "awesome" nested traces Joel has seen — tool calls as children, streaming TTFT, automatic cost.

## Debugging Traces

### Check recent traces
```bash
source <(grep -E 'LANGFUSE_(PUBLIC_KEY|SECRET_KEY|HOST)' ~/.joelclaw/scripts/gateway-start.sh | sed 's/export //')
curl -s -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY" \
  "https://us.cloud.langfuse.com/api/public/traces?limit=5&orderBy=timestamp.desc" \
  | jq '.data[] | {name, ts: .timestamp[:19], userId, tags, has_input: (.input != null), has_output: (.output != null)}'
```

### Check generations on a trace
```bash
TRACE_ID="<id>"
curl -s -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY" \
  "https://us.cloud.langfuse.com/api/public/observations?traceId=$TRACE_ID" \
  | jq '.data[] | {name, type, model, usageDetails, costDetails}'
```

### Filter by tag
```bash
curl -s -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY" \
  "https://us.cloud.langfuse.com/api/public/traces?limit=5&orderBy=timestamp.desc&tags=system-bus" \
  | jq '.data[] | {name, ts: .timestamp[:19], tags}'
```

### CLI aggregate
```bash
joelclaw langfuse aggregate --hours 24
```

### Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| No traces appearing | `langfuse` dep not installed | `bun add langfuse` in extension dir |
| `userId: null` | Missing `userId` on trace | Add `userId: "joel"` to trace creation |
| `input === output` | Extension captures assistant text as both | Clear `lastUserInput` after use |
| `channel:interactive` | `GATEWAY_ROLE` not set | Add `export GATEWAY_ROLE=central` to `gateway-start.sh` |
| `session:interactive` | `"central"` not in session type enum | Add to `getSessionType()` |
| `resourceAttributes` noise | OTEL boilerplate | Set proper `service.name` in provider resource |
| Traces only from one source | Other source not configured | Check both langfuse-cost extension AND system-bus langfuse.ts |
| Extension not loading | Symlink missing | `ln -s ...pi-tools/langfuse-cost ~/.pi/agent/extensions/langfuse-cost` |
| Git cache stale | Extension code outdated | `cd ~/.pi/agent/git/.../pi-tools && git fetch origin && git reset --hard origin/main` |

## ADRs

- **ADR-0146**: Inference Cost Monitoring and Control (Langfuse is implementation)
- **ADR-0147**: Named Agent Profiles (Langfuse trace attribution by role)

## Key Files

- Pi extension: `~/Code/joelhooks/pi-tools/langfuse-cost/index.ts`
- System-bus: `packages/system-bus/src/lib/langfuse.ts`
- Gateway start: `~/.joelclaw/scripts/gateway-start.sh`
- Extension symlink: `~/.pi/agent/extensions/langfuse-cost`
- Git cache: `~/.pi/agent/git/github.com/joelhooks/pi-tools/`

## What "Awesome" Looks Like

The AI SDK + Langfuse integration produces traces with:
1. **Nested hierarchy**: Agent → Tool calls → Generations as proper parent-child
2. **Automatic I/O**: Function inputs captured, outputs captured
3. **Streaming TTFT**: `completionStartTime` on generations
4. **Cost per generation**: `usageDetails` + `costDetails` with cache tokens
5. **Session replay**: Same `sessionId` groups entire conversations
6. **Filterable tags**: `provider:anthropic`, `model:claude-opus-4-6`, `channel:central`
7. **Flat metadata**: Every key filterable in Langfuse UI

Our current setup achieves 4-7 but not 1-3 fully. The pi extension can't create nested tool-call children because it only sees aggregate `message_end` events, not individual tool invocations. To get there, we'd need either:
- Pi SDK to emit per-tool-call events (upstream change)
- Move to AI SDK for gateway inference (architectural change)
- Or accept the current granularity as sufficient for cost monitoring
