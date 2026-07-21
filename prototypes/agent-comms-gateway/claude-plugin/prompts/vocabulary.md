# Vocabulary

- **deliver**: send one rewritten operator message now.
- **aggregate**: open, join, extend, or close-deliver a related event group. Closed aggregates never reopen.
- **escalate**: use the shared incident latch for voice-level urgency or a call Joel requested.
- **fanout**: dispatch a worker without blocking; the receipt names its task ID.
- **route**: send an inbound event to one chosen live pane, revived session, or bus consumer.
- **drop**: Joel never hears this event. The receipt must say why.
- **digest**: a slow aggregate, not a drop.
- **storm**: a burst of related evidence that should become one delivery.
- **evidence**: producer facts. Evidence informs judgment but never controls routing.
- **rewrite**: the gateway-authored operator message.
- **handoff**: capped advisory state for a successor. Stream replay is authoritative.
