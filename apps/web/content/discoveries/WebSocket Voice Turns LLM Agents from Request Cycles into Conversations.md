---
type: discovery
slug: websocket-voice-turns-llm-agents-from-request-cycles-into-conversations
source: "https://developers.openai.com/api/docs/guides/websocket-mode"
discovered: "2026-02-24"
tags: [article, ai, websocket, voice, openai, livekit, realtime, infrastructure, agent-loops, event-bus, tools]
relevance: "Persistent websocket streams map better to joelclaw's event-driven loops than request-response polling when voice sessions drive actions"
---

# WebSocket Voice Turns LLM Agents from Request Cycles into Conversations

Most voice-agent glue code treats talking to an LLM like tiny, isolated API calls: send an audio chunk, wait, repeat. That model leaks latency and throws away flow. The [OpenAI WebSocket mode guide](https://developers.openai.com/api/docs/guides/websocket-mode) reframes voice as a persistent stream instead, which is closer to a conversation than a queue. Pairing that transport with [LiveKit](https://livekit.io/) puts audio, state, and control on one continuously open lane.

The clever part is not that the docs are shiny; it is that this shape fits how the system already thinks. In [joelclaw](https://joelclaw.com), you already pay for every useful event in an event bus, and [Inngest](https://www.inngest.com/) durable runs already assume long-lived, replayable flow. A websocket session can emit partial transcriptions, interruption signals, and action intents as they happen instead of waiting for each response boundary. For [agent loops](/adrs/adr-0015), that removes a layer of conversion glue.

For a practical build, the upside is obvious and the risk is equally obvious: long-lived connections need cleanup and recovery discipline. [WebSockets](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket) can be dropped, token streams can desync, and the wrong defaults make retry logic look random. Treating voice as stream events is a transport win only if ownership boundaries, backpressure, and idempotent side effects are explicit. That makes this relevant to [joelclaw gateway](/system) and [system observability](/system/events), where the hard part is not speed but keeping a durable audit trail of what happened during a live stream.

## Key Ideas

- **Session = open channel**: websocket voice keeps the transport alive across turns, so [transcription](https://platform.openai.com/docs/guides/speech-to-text), [tooling](https://platform.openai.com/docs/guides/function-calling) and control signals can flow without one-off round trips.
- **Lower coordination friction**: when stream payloads are eventified, [agent-loops](/adrs/adr-0015) can process partials and still maintain deterministic handoff points.
- **Resilience is part of the API surface**: stateful streams force explicit lifecycle handling such as reconnect, heartbeat, and cancellation semantics via the same event model used by your [event bus](/system/events).
- **Gateway architecture fit**: [joelclaw gateway](/system) can treat websocket frames as commands in-flight, which aligns with existing [worker](/system) and [Inngest](/adrs/adr-0015) integration patterns.
- **Less glue, clearer contract**: you still need protocol discipline, but fewer adapters around start/stop loops means less [state conversion](/adrs/adr-0015) overhead in production.

## Links

- [OpenAI WebSocket mode guide (source)](https://developers.openai.com/api/docs/guides/websocket-mode)
- [OpenAI API docs overview](https://platform.openai.com/docs/overview)
- [OpenAI Realtime API reference](https://platform.openai.com/docs/api-reference/realtime)
- [LiveKit documentation](https://docs.livekit.io/)
- [WebSocket API specification (RFC 6455)](https://www.rfc-editor.org/rfc/rfc6455)
- [joelclaw system page](https://joelclaw.com/system)
- [joelclaw events page](https://joelclaw.com/system/events)
- [joelclaw ADR-0015: Agent Loop Architecture](/adrs/adr-0015)
- [joelclaw Discovery: Discord Components as Agent Control Plane](/cool/Discord%20Components%20as%20Agent%20Control%20Plane)
- [joelclaw Discovery: AI Coworkers Need a Form Factor, Not Better Prompts](/cool/AI%20Coworkers%20Need%20a%20Form%20Factor%2C%20Not%20Better%20Prompts)
