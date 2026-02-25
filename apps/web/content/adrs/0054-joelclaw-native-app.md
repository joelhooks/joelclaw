---
type: adr
status: proposed
date: 2026-02-19
decision-makers: joel
tags:
  - native-app
  - swiftui
  - ios
  - watchos
  - carplay
  - voice
  - gateway
  - healthkit
  - push-notifications
related:
  - "0004-atproto-federation-native-app"
  - "0038-embedded-pi-gateway-daemon"
  - "0043-agent-voice-conversations"
  - "0045-task-management-ports-and-adapters"
  - "0049-gateway-tui-via-websocket"
  - "0052-email-port-hexagonal-architecture"
---

# ADR-0054: joelclaw Native App — iPhone, Watch, CarPlay

## Context

joelclaw has a working agent infrastructure: gateway daemon (ADR-0038), event bus (Inngest), voice pipeline (ADR-0043 / LiveKit), task management (ADR-0045), email (ADR-0052), comms channels (Telegram, webhooks), and AT Protocol data layer (ADR-0004). The CLI tools (pi, joelclaw, slog) are powerful but terminal-bound.

The missing piece is a **native client** — not a web wrapper, not a chat widget. A full Apple-ecosystem app that makes joelclaw a personal operating system you carry in your pocket, wear on your wrist, and talk to while driving.

### Why Native SwiftUI (not React Native / Expo)

- **CarPlay** requires native Swift — no cross-platform framework supports it properly
- **watchOS** requires native Swift — WatchKit / SwiftUI only
- **HealthKit** is a native framework — direct Swift API, no bridge overhead
- **CallKit** for voice-call-like agent conversations — native only
- **Siri Shortcuts / App Intents** — native Swift integration
- **Secure Enclave** for DID private keys — Keychain + native crypto
- **Background processing** — BGTaskScheduler, push notification handling
- **Widgets / Live Activities** — WidgetKit, ActivityKit are SwiftUI-native

The agent's brain stays on the Mac Mini. The app is a rich, context-aware face.

## Decision

**Build a SwiftUI native app spanning iPhone, Apple Watch, and CarPlay. The app connects to the gateway daemon (ADR-0038/0049) as a first-class channel — alongside Telegram, Discord, SMS, and any future channel. All data flows through the PDS (ADR-0004).**

### Core Principle: The App Is a Channel

The gateway daemon (ADR-0038) already handles multi-channel routing. The app is "just another channel" — but the richest one. It doesn't run the agent. It connects to the agent.

```
┌───── Apple Ecosystem ──────────────────────────────────────────┐
│                                                                 │
│  iPhone App          Watch App          CarPlay App             │
│  ├─ Chat             ├─ Complications   ├─ Voice agent          │
│  ├─ Voice (LiveKit)  ├─ Voice (quick)   ├─ Dashboard            │
│  ├─ Tasks            ├─ Tasks           ├─ Location context     │
│  ├─ Health           ├─ Health logging  └─────────┐             │
│  ├─ Comms hub        ├─ Notifications             │             │
│  ├─ System           └───────┐                    │             │
│  └───────┐                   │                    │             │
│          │                   │                    │             │
└──────────┼───────────────────┼────────────────────┼─────────────┘
           │ WebSocket (ADR-0049)                   │
           │ LiveKit WebRTC (ADR-0043)              │
           │ XRPC (ADR-0004)                        │
           ▼                                        ▼
┌───── Mac Mini (panda) ─────────────────────────────────────────┐
│                                                                 │
│  Gateway Daemon ←──── WebSocket ────── App                     │
│  ├─ Agent session (pi SDK)                                     │
│  ├─ Channel router (Telegram, app, Discord, SMS, ...)          │
│  ├─ Tool dispatch                                              │
│  └─ Smart notification routing                                 │
│                                                                 │
│  LiveKit Server ←──── WebRTC ──────── Voice (phone/watch/car)  │
│  ├─ Deepgram STT                                               │
│  ├─ Claude LLM                                                 │
│  ├─ ElevenLabs TTS                                             │
│  └─ @function_tool → system tools                              │
│                                                                 │
│  PDS ←──── XRPC ──────────────────── All data reads/writes    │
│  Inngest ← events ────────────────── Push notification source  │
│  Redis ──── pub/sub ──────────────── Real-time state           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Gateway Is the Brain, App Is the Face

The app **never** runs agent logic locally. All intelligence stays on the Mac Mini:

| Concern | Where it runs |
|---------|---------------|
| LLM inference | Mac Mini (via OpenRouter/Claude) |
| Tool execution | Mac Mini (gateway daemon) |
| Voice pipeline | Mac Mini (LiveKit + agents) |
| Event processing | Mac Mini (Inngest worker) |
| Data storage | Mac Mini → PDS → NAS |
| Push routing | Mac Mini (agent decides where/when to notify) |
| UI rendering | Device (SwiftUI) |
| Audio capture | Device (microphone → LiveKit WebRTC) |
| Health data | Device (HealthKit → PDS sync) |
| Location data | Device (CoreLocation → PDS/gateway) |

---

## App Surfaces

### 1. iPhone App

#### Chat (Primary Tab)
The conversational interface — same agent, richer than Telegram.

- Thread list with conversation history (PDS `dev.joelclaw.agent.thread` records)
- Streaming text responses via gateway WebSocket (ADR-0049 protocol)
- Rich content: code blocks, images, file references, vault links, tool call results
- Quick actions: voice mode toggle, send file, share location
- Inline tool call visibility ("Checking your calendar..." with spinner)
- Message reactions for feedback (agent learns preferences)

#### Voice Mode 🎙️
Tap to talk. LiveKit WebRTC to the self-hosted server.

- LiveKit Swift SDK (`livekit/client-sdk-swift`) joins room
- Full duplex audio — interrupt the agent mid-sentence
- Visual waveform / speaking indicator
- Transcript overlay (optional — see what was said)
- Seamless handoff: start typing → switch to voice → back to typing
- Background audio session — keep talking while switching apps
- CallKit integration — agent conversations look/feel like phone calls

```swift
// Voice mode entry point
import LiveKit

let room = Room()
let token = try await gateway.createVoiceRoom()
try await room.connect(url: "wss://<internal-tailnet-host>:7443", token: token)
// Agent auto-joins, greets user, conversation begins
```

#### Tasks
PDS-native task management. Todoist is one adapter (ADR-0045).

- Task list with projects, priorities, due dates
- Quick add (text or voice: "remind me to deploy the pipeline tomorrow")
- PDS records: `dev.joelclaw.task.item` — source of truth
- Todoist sync as adapter (bidirectional, eventually replaceable)
- Agent-suggested tasks ("You mentioned wanting to fix the NAS layout — want me to add that?")
- Shared family tasks via `dev.joelclaw.family.list`

#### Health
Apple Health integration — agent-aware, not a health app.

- **Read**: Sleep, steps, HRV, workouts, resting heart rate, active energy
- **Write**: Meals, water intake, custom metrics, agent-logged observations
- **Context**: Agent uses health data to adjust behavior
  - "You slept 5 hours — light day suggested, moving the deploy window?"
  - "HRV is low — might not be the best day for that hard conversation"
  - "You've been sedentary for 3 hours — walk break?"
- **Dashboard**: Simple daily summary cards, trends, agent observations
- PDS records: `dev.joelclaw.health.daily` — agent-enriched health summary
- HealthKit sync runs in background via BGTaskScheduler

#### Comms Hub
Unified inbox — agent triages the noise, you see what matters.

- **Channels**: Email (gogcli/ADR-0052), Telegram, Discord, SMS, future channels
- **Agent triage**: Every incoming message gets agent assessment
  - 🔴 Urgent — push immediately
  - 🟡 Needs attention — surface in comms hub
  - 🟢 Informational — batch digest
  - ⚪ Noise — archive silently
- **Draft assistance**: Agent pre-drafts replies, you approve/edit/send
- **Unified thread view**: See the full conversation across channels
  - "Joel texted you, then emailed, then Slacked — here's the thread"
- **Smart compose**: "Reply to Sarah's email" → agent drafts, you review

#### System (Operator Tab)
For Joel only. Hidden for family members.

- Inngest function list + recent runs + failures
- Active coding loops (ralph iterations, story progress)
- k8s pod status, resource usage
- Qdrant collection stats, embedding queue
- Worker health, function count, last heartbeat
- Gateway session state (streaming, queue depth, uptime)
- slog tail — recent system changes

#### Settings / Me
- DID identity, handle, PDS status
- Channel preferences (which channels are active, priority)
- Notification preferences (categories, quiet hours, smart routing overrides)
- Voice settings (voice ID, speed, personality adjustments)
- Health sync toggles (which HealthKit categories to share)
- Family network (connected PDSs, shared data)

### 2. Apple Watch App

The watch is a **glance-and-voice** surface. Don't fight the screen size.

#### Complications
- **Next task** — title + due time
- **System health** — green/yellow/red dot
- **Active loops** — count + status
- **Last agent message** — preview text
- **Health score** — agent's daily assessment

#### Voice (Quick Agent)
Raise wrist, tap complication, talk.

- LiveKit WebRTC via watchOS audio session
- Short exchanges: "What's next?" "Any notifications?" "Add a task"
- Agent responds through watch speaker or AirPods
- Auto-disconnect after 30s silence (save battery)

#### Tasks
- Today's tasks — swipe to complete
- Quick add via voice
- Shared family task list

#### Health Logging
- Quick log: water, meals, mood, energy level
- Workout detection → agent context ("Nice run — 5K in 28 minutes")
- Apple Watch sensor data (HR, HRV, blood oxygen) → HealthKit → PDS

#### Notifications
- Smart haptics — different patterns for urgency levels
- Inline reply for simple responses
- "Handle this" quick action → agent takes default action

### 3. CarPlay App

The car is a **voice-first, location-aware** surface.

#### Voice Agent (Primary)
- Always-on voice conversation while driving
- LiveKit WebRTC via car's audio system
- Agent adjusts personality: concise, no code blocks, action-oriented
- "What's on my calendar?" "Read my last email from Sarah" "Add milk to the grocery list"

#### Dashboard
CarPlay template-based UI (CPListTemplate, CPInformationTemplate):

- Next calendar event + ETA
- Today's priority tasks
- Active reminders
- System status (green/yellow/red)

#### Location Awareness
The killer feature. Agent knows where you are and acts on it.

- **Geofencing**: "You're at Target — you needed paper towels and batteries for the smoke detectors"
- **Proximity alerts**: "You're 5 minutes from home — want me to text [partner] your ETA?"
- **Commute context**: "Traffic is heavy on 101, 45 minutes to the office. You have a meeting in 30 — want me to message them you'll be late?"
- **Errand optimization**: "You have 3 errands today. Target is on the way to the dentist — want to stop there first?"
- CoreLocation significant location changes + geofence monitoring
- Location events → PDS → Inngest → agent context

#### Handoff
- Start a conversation on CarPlay → continue on phone when you park
- Voice transcript available in chat tab
- Decisions captured during drive → task list updated

---

## Smart Notification Routing

The agent decides **where** and **when** to notify, not just **what**.

```
┌─── Agent Triage ───────────────────────────────────────────────┐
│                                                                 │
│  Incoming signal (email, event, task due, health, system)      │
│      ↓                                                          │
│  Agent assesses: urgency × context × user state                │
│      ↓                                                          │
│  ┌─ Driving (CarPlay active)                                   │
│  │  → Urgent: speak it ("Sarah just called, want me to call    │
│  │    back?")                                                   │
│  │  → Normal: hold for later                                   │
│  │  → Noise: suppress                                          │
│  │                                                              │
│  ├─ At desk (no app active, gateway idle)                      │
│  │  → Queue in gateway, surface on next interaction            │
│  │  → Or: push to phone if idle > 30min                        │
│  │                                                              │
│  ├─ Phone active (app in foreground)                           │
│  │  → In-app banner                                            │
│  │                                                              │
│  ├─ Watch only (phone locked, watch on wrist)                  │
│  │  → Haptic tap + complication update                         │
│  │  → Urgent: haptic + audio through AirPods                  │
│  │                                                              │
│  ├─ Sleeping (DND / sleep focus active)                        │
│  │  → Only true emergencies (system down, family emergency)    │
│  │  → Everything else → morning briefing                       │
│  │                                                              │
│  └─ Workout (watch detecting exercise)                         │
│     → Suppress everything except urgent                        │
│     → Post-workout summary                                     │
└─────────────────────────────────────────────────────────────────┘
```

Implementation:
- Device reports context to gateway: `{ focus: "driving", activeDevice: "carplay", location: {...} }`
- Gateway stores user context in Redis
- Agent notification functions check context before routing
- APNs for push (requires server-side APNs integration via Inngest function)
- LiveKit for voice interrupts (agent joins existing room or creates one)

---

## Technical Architecture

### Connectivity

| Protocol | Purpose | Endpoint |
|----------|---------|----------|
| WebSocket | Gateway chat, streaming, tool calls | `wss://<internal-tailnet-host>:3443/ws` (ADR-0049) |
| WebRTC | Voice conversations (LiveKit) | `wss://<internal-tailnet-host>:7443` (ADR-0043) |
| XRPC | PDS data reads/writes | `https://<internal-tailnet-host>:9627` (ADR-0004/0044) |
| APNs | Push notifications | Apple → device (server-side via Inngest) |
| HealthKit | Health data sync | On-device → PDS (background task) |
| CoreLocation | Location events | On-device → gateway (significant changes) |

### Swift Dependencies

| Package | Purpose |
|---------|---------|
| `livekit/client-sdk-swift` | WebRTC voice rooms |
| `swift-atproto` or thin XRPC client | PDS reads/writes |
| `Starscream` or native URLSessionWebSocket | Gateway WebSocket |
| HealthKit framework | Apple Health integration |
| CoreLocation framework | Location awareness |
| CallKit framework | Voice-call UX for agent conversations |
| WidgetKit / ActivityKit | Home screen widgets, Live Activities |
| AppIntents | Siri Shortcuts integration |

### Data Flow

```
Device → Gateway:
  WebSocket: { type: "prompt", text: "...", source: "app", context: { device, location, focus } }
  
Gateway → Device:
  WebSocket: { type: "text_delta" | "tool_call" | "tool_result" | "turn_end" }

Device → PDS:
  XRPC: com.atproto.repo.createRecord (tasks, health logs, preferences)
  
PDS → Device:
  XRPC subscription: real-time record updates (firehose)

Inngest → Device:
  APNs: push notification with payload { category, urgency, preview }
```

### Offline Behavior

The app must work without connectivity (Airplane mode, poor signal):

- **Chat history**: Cached in SwiftData, synced to PDS when online
- **Tasks**: Local SwiftData copy, conflict resolution on sync
- **Health**: HealthKit is always local, synced to PDS in background
- **Queued messages**: Sent when connectivity returns (gateway reconnect)
- **Voice**: Requires connectivity (WebRTC needs network). Show "offline" state.

---

## Family App Variant

Family members see a simplified app:

| Tab | Family Version |
|-----|----------------|
| Chat | ✅ Talk to their own agent |
| Voice | ✅ Same LiveKit voice (own agent, simpler personality) |
| Tasks | ✅ Personal + shared family lists |
| Health | ✅ If they opt in |
| Comms | ❌ Not included |
| System | ❌ Not included |
| Shared | ✅ Family lists, reminders, automations |

Each family member has their own PDS, own DID, own agent instance. The family relay (ADR-0004) enables cross-agent communication.

---

## Implementation Phases

### Phase 0: Foundation
- [ ] Xcode project setup — SwiftUI, multi-target (iOS, watchOS, CarPlay)
- [ ] Gateway WebSocket client (ADR-0049 protocol)
- [ ] PDS XRPC client (thin Swift wrapper over URLSession)
- [ ] LiveKit Swift SDK integration
- [ ] Authentication flow (DID-based, keys in Keychain/Secure Enclave)

### Phase 1: iPhone MVP
- [ ] Chat tab — text conversation with gateway
- [ ] Voice mode — LiveKit room join, full duplex audio
- [ ] Tasks tab — PDS-native task CRUD
- [ ] Push notifications — APNs from Inngest functions
- [ ] System tab (Joel only) — basic health cards

### Phase 2: Watch + Health
- [ ] watchOS app — complications, quick voice, task list
- [ ] HealthKit read integration — sleep, steps, HRV → PDS
- [ ] HealthKit write — meals, water, custom metrics
- [ ] Agent health context — morning briefing includes health data
- [ ] Workout detection → agent context

### Phase 3: CarPlay + Location
- [ ] CarPlay app — voice agent, dashboard, next event
- [ ] CoreLocation integration — significant location changes
- [ ] Geofencing — location-aware reminders and nudges
- [ ] Driving mode personality — agent adapts to car context
- [ ] Handoff — car → phone → watch continuity

### Phase 4: Comms Hub
- [ ] Unified inbox — email, Telegram, Discord, SMS
- [ ] Agent triage — urgency classification, smart batching
- [ ] Draft assistance — agent pre-drafts, user approves
- [ ] Smart notification routing — context-aware delivery
- [ ] Cross-channel threading

### Phase 5: Family
- [ ] Family PDS instances + simplified agents
- [ ] Shared task lists, reminders, automations
- [ ] Family app variant (simplified tab set)
- [ ] Cross-agent communication via relay
- [ ] Per-person Tailscale ACLs

## Consequences

- **SwiftUI-only** means no Android. This is deliberate — Joel's family is Apple. If Android is needed later, the gateway + PDS architecture means any client can connect.
- **Gateway-as-brain** means the phone doesn't need to be powerful. A $200 SE could run this app. All intelligence is on the Mac Mini.
- **Location awareness is powerful but sensitive.** All location data stays on the PDS (self-hosted NAS). No cloud location services.
- **Push notifications require APNs server integration.** Need an Apple Developer account + server-side APNs client (Inngest function with `apns` adapter).
- **HealthKit data is deeply personal.** PDS keeps it self-hosted. Agent health context is opt-in per category.
- **CarPlay voice agent is the killer feature.** Hands-free, eyes-free, full agent access while driving. This is the "why native" justification in a single feature.
- **Watch app extends presence.** The agent is always reachable — raise wrist, talk. No phone needed.

## Open Questions

1. **App Store vs TestFlight** — Ship via App Store (review friction, public) or TestFlight (family distribution, 90-day expiry, up to 100 users)?
2. **APNs infrastructure** — Inngest function with `@parse/node-apn`? Or a dedicated push service?
3. **Swift AT Protocol client** — Build thin XRPC wrapper or adopt community `swift-atproto` if mature?
4. **Siri integration depth** — App Intents for shortcuts, or full SiriKit domains (messaging, lists)?
5. **Widget strategy** — Which widgets on day one? System health? Next task? Last agent message?

## Credits

- Apple — SwiftUI, HealthKit, CarPlay, watchOS, CallKit, WidgetKit, App Intents frameworks
- LiveKit — `client-sdk-swift` for WebRTC voice on Apple platforms
- AT Protocol / Bluesky — identity and data layer (ADR-0004)
- OpenClaw — gateway-as-brain pattern, channel plugin architecture
- Pi SDK (mariozechner) — `createAgentSession()` powering the gateway daemon
