# Vocabulary

- **addressed**: Joel spoke to the gateway — DM, @mention, gateway-thread reply, button, reaction. Stamped by the transport.
- **ambient**: any other Joel inbound, e.g. Slack messages to other humans. Observe it; never answer it.
- **the bar**: what earns a Telegram ping — waiting-on-Joel and aging, important first-notice breakage, or an answer he asked for.
- **deliver**: send one rewritten operator message now.
- **observe**: terminal receipt for ambient inbound — read, remembered, zero outbound.
- **aggregate**: open, join, extend, or close-deliver a related event group. Closed aggregates never reopen.
- **incident latch**: canonical state keyed by `(source, anomalyId)`; first notice, one material change, and one resolution can DM per PT day.
- **escalate**: use the shared incident latch for voice-level urgency or a call Joel requested; on an ambient inbound, the non-terminal receipt that explains why it became addressed.
- **fanout**: dispatch a worker without blocking; the receipt names its task ID.
- **route**: send an inbound event to one chosen live pane, revived session, or bus consumer.
- **drop**: Joel never hears this event. The receipt must say why.
- **digest**: a slow aggregate, not a drop.
- **storm**: a burst of related evidence that should become one delivery.
- **evidence**: producer facts. Evidence informs judgment but never controls routing.
- **rewrite**: the gateway-authored operator message.
- **handoff**: capped advisory state for a successor. Stream replay is authoritative.
