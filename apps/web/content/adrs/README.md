---
type: index
tags:
  - adr
  - decisions
---

# Architecture Decision Records

| ADR | Title | Status | Date |
|-----|-------|--------|------|
| [0001](0001-adopt-architecture-decision-records.md) | Adopt architecture decision records | accepted | 2026-02-14 |
| [0002](0002-personal-assistant-system-architecture.md) | Adopt PARA vault + OpenClaw orchestration for always-on personal assistant | accepted (partially superseded by 0003) | 2026-02-14 |
| [0003](0003-joelclaw-over-openclaw.md) | Build joelclaw instead of deploying OpenClaw | accepted | 2026-02-14 |
| [0004](0004-atproto-federation-native-app.md) | AT Protocol as bedrock + native iPhone app | accepted | 2026-02-14 |
| [0005](0005-durable-multi-agent-coding-loops.md) | Adopt Inngest multi-agent pipeline for durable autonomous coding loops | shipped | 2026-02-14 |
| [0006](0006-observability-prometheus-grafana.md) | Adopt Prometheus + Grafana for system observability | superseded by 0087 | 2026-02-14 |
| [0007](0007-agent-loop-v2-improvements.md) | Agent Loop V2 Improvements | proposed | 2026-02-14 |
| [0008](0008-loop-retrospective-and-skill-evolution.md) | Loop Retrospective and Skill Evolution | proposed | 2026-02-14 |
| [0009](0009-rename-igs-cli-to-joelclaw.md) | Rename igs CLI to joelclaw | proposed | 2026-02-15 |
| [0010](0010-system-loop-gateway.md) | System Loop (OpenClaw Gateway) | proposed | 2026-02-15 |
| [0011](0011-redis-backed-loop-state.md) | Redis-Backed PRD State for Agent Loops | accepted | 2026-02-14 |
| [0012](0012-planner-generates-prd.md) | Planner Generates PRD from Goal | proposed | 2026-02-14 |
| [0013](0013-llm-judge-evaluation.md) | LLM-Powered Judge Evaluation | proposed | 2026-02-14 |
| [0014](0014-agent-memory-workspace.md) | Agent Memory Workspace | superseded by 0021 | 2026-02-14 |
| [0015](0015-loop-architecture-tdd-roles.md) | Loop Architecture TDD Roles | proposed | 2026-02-14 |
| [0016](0016-loop-idempotency-guards.md) | Loop Idempotency Guards | proposed | 2026-02-14 |
| [0017](0017-parallel-story-execution.md) | Parallel Story Execution | proposed | 2026-02-14 |
| [0018](0018-pi-native-gateway-redis-event-bridge.md) | Pi-native gateway with Redis event bridge | proposed | 2026-02-14 |
| [0019](0019-event-naming-past-tense.md) | Rename events to past-tense notifications | proposed | 2026-02-15 |
| [0020](0020-observational-memory-pipeline.md) | Observational memory pipeline (Observer/Reflector) | superseded by 0021 | 2026-02-15 |
| [0021](0021-agent-memory-system.md) | Comprehensive agent memory system (supersedes 0014, 0020) | proposed | 2026-02-15 |
| [0022](0022-webhook-to-system-event-pipeline.md) | Webhook-to-system-event pipeline | superseded | 2026-02-15 |
| [0023](0023-docker-sandbox-for-agent-loops.md) | Docker Sandbox for Agent Loops | shipped | 2026-02-15 |
| [0024](0024-taxonomy-enhanced-session-search.md) | Taxonomy-Enhanced Session Search with SKOS Concept Layer | deferred | 2026-02-16 |
| [0025](0025-k3s-cluster-for-joelclaw-network.md) | Network Architecture — Start with What Works, Grow as Needed | shipped | 2026-02-17 |
| [0026](0026-background-agents-via-inngest.md) | Background Agents via Inngest with File Inbox Notifications | deferred | 2026-02-16 |
| [0027](0027-video-content-pipeline-expansion.md) | Video Content Pipeline Expansion — Clip Segmentation + Content Repurposing | deferred | 2026-02-16 |
| [0028](0028-inngest-rig-alignment-with-sdk-skills.md) | Align Inngest Rig with SDK Best Practices | shipped | 2026-02-16 |
| [0029](0029-replace-docker-desktop-with-colima.md) | Replace Docker Desktop + k3d with Colima + Talos | shipped | 2026-02-17 |
| [0030](0030-cilium-cni-kube-proxy-replacement.md) | Replace Flannel + kube-proxy with Cilium | deferred | 2026-02-17 |
| [0031](0031-cilium-gateway-api.md) | Adopt Cilium Gateway API Instead of Ingress | deferred | 2026-02-17 |
| [0032](0032-kubernetes-storage-ceph-rook-vs-seaweedfs.md) | Kubernetes Persistent Storage — Ceph Rook vs SeaweedFS vs local-path | deferred | 2026-02-17 |
| [0033](0033-victoriametrics-grafana-monitoring-stack.md) | VictoriaMetrics + Grafana monitoring stack for Kubernetes | superseded by 0087 | 2026-02-17 |
| [0034](0034-flux-operator-gitops.md) | Flux Operator for GitOps Cluster Management | deferred | 2026-02-17 |
| [0035](0035-gateway-session-routing-central-satellite.md) | Central + satellite session routing for gateway events | shipped | 2026-02-17 |
| [0036](0036-launchd-central-gateway-session.md) | Run central gateway session as a launchd-managed daemon | superseded | 2026-02-17 |
| [0037](0037-gateway-watchdog-layered-failure-detection.md) | Layered watchdog for gateway heartbeat failure detection | shipped | 2026-02-17 |
| [0038](0038-embedded-pi-gateway-daemon.md) | Embed pi as a library in a joelclaw gateway daemon | shipped | 2026-02-17 |
| [0039](0039-self-host-convex-for-joelclaw.md) | Self-host Convex as the real-time data layer for joelclaw.com | deferred | 2026-02-18 |
| [0040](0040-google-workspace-via-gogcli.md) | Google Workspace Access via gogcli | shipped | 2026-02-18 |
| [0041](0041-first-class-media-from-channels.md) | First-Class Media Handling from Connected Channels | deferred | 2026-02-18 |
| [0042](0042-telegram-rich-replies-and-outbound-media.md) | Telegram Rich Replies, Outbound Media, and Agent Voice | accepted | 2026-02-18 |
| [0043](0043-agent-voice-conversations.md) | Agent Voice Conversations via Self-Hosted LiveKit | accepted | 2026-02-19 |
| [0044](0044-pds-private-first-with-bento-bridge.md) | Private-First PDS with Bento Bridge | accepted | 2026-02-18 |
| [0045](0045-task-management-ports-and-adapters.md) | Task Management via Ports and Adapters | shipped | 2026-02-18 |
| [0046](0046-things-cli-typescript-port.md) | TypeScript Things CLI via joelclaw Tasks Subcommand | withdrawn | 2026-02-18 |
| [0047](0047-todoist-as-conversation-channel.md) | Todoist as Async Conversation Channel | shipped | 2026-02-18 |
| [0048](0048-webhook-gateway-system.md) | Webhook Gateway for External Service Integration | shipped | 2026-02-18 |
| [0049](0049-gateway-tui-via-websocket.md) | Gateway TUI via WebSocket | shipped | 2026-02-18 |
| [0050](0050-gateway-session-resume-and-codex-model.md) | Gateway session resume via fixed file path and codex model pinning | shipped | 2026-02-18 |
| [0051](0051-tailscale-funnel-as-public-ingress.md) | Tailscale Funnel as Public Ingress for Webhooks | shipped | 2026-02-18 |
| [0052](0052-email-port-hexagonal-architecture.md) | Email Port — Hexagonal Architecture with Dual Adapters | shipped | 2026-02-18 |
| [0053](0053-event-prompts-and-agent-triage.md) | Event-emitter prompts and the Agency triage principle | shipped | 2026-02-18 |
| [0054](0054-joelclaw-native-app.md) | joelclaw Native App — iPhone, Watch, CarPlay | proposed | 2026-02-19 |
| [0055](0055-granola-meeting-intelligence-pipeline.md) | Granola Meeting Intelligence Pipeline | proposed | 2026-02-19 |
| [0056](0056-personal-relationship-management.md) | Personal Relationship Management — People as First-Class Entities | proposed | 2026-02-19 |
| [0057](0057-skill-pack-distribution.md) | Skill Pack Distribution — Install from Source | shipped | 2026-02-19 |
| [0058](0058-streamed-ndjson-cli-protocol.md) | Streamed NDJSON Protocol for Agent-First CLIs | accepted | 2026-02-19 |
| [0059](0059-multi-language-lsp-extension.md) | Multi-Language LSP Extension for pi-tools | proposed | 2026-02-19 |
| [0060](0060-inngest-swarm-dag-orchestration.md) | Inngest-Backed Swarm/DAG Multi-Agent Orchestration | proposed | 2026-02-19 |
| [0061](0061-pi-tools-enhancement-cycle.md) | pi-tools Enhancement Cycle — Commit Tool, Web Extractors, MCQ | proposed | 2026-02-19 |
| [0062](0062-heartbeat-task-triage.md) | Heartbeat-Driven Task Triage | proposed | 2026-02-19 |
| [0063](0063-client-side-search-pagefind.md) | Client-Side Search with Pagefind | shipped | 2026-02-19 |
| [0064](0064-elixir-beam-evaluation.md) | Evaluate Elixir/BEAM as joelclaw Backbone | superseded by 0114 | 2026-02-19 |
| [0065](0065-friction-auto-fix.md) | Friction Auto-Fix — Bias Towards Action | accepted | 2026-02-19 |
| [0066](0066-inngest-monitor-pi-extension.md) | Inngest Monitor Pi Extension | accepted | 2026-02-19 |
| [0067](0067-community-skill-patterns.md) | Integrate Community Skill Patterns | accepted | 2026-02-19 |
| [0068](0068-memory-proposal-triage.md) | Memory Proposal Auto-Triage Pipeline | shipped | 2026-02-19 |
| [0069](0069-gateway-proactive-notifications.md) | Gateway Proactive Telegram Notifications | shipped | 2026-02-19 |
| [0070](0070-telegram-rich-notifications.md) | Telegram Rich Notifications with Inline Keyboards | accepted | 2026-02-19 |
| [0071](0071-notification-triage-classes.md) | Notification Triage Classes | shipped | 2026-02-20 |
| [0072](0072-vip-email-intelligence-pipeline.md) | VIP Email Intelligence Pipeline | proposed | 2026-02-20 |
| [0073](0073-person-dossier-system.md) | Automatic person dossier system from communication history | proposed | 2026-02-20 |
| [0074](0074-sandbox-work-extraction-pattern.md) | Sandbox Work Extraction Pattern | proposed | 2026-02-20 |
| [0075](0075-joelclaw-auth-better-auth-github-convex.md) | joelclaw.com Authentication with Better Auth + GitHub + Convex | proposed | 2026-02-20 |
| [0076](0076-enhanced-agent-markdown-instructions.md) | Enhanced Agent-Specific Markdown Instructions | proposed | 2026-02-20 |
| [0077](0077-memory-system-next-phase.md) | Memory System — Next Phase | shipped | 2026-02-20 |
| [0078](0078-opus-token-reduction.md) | Opus Token Reduction Across joelclaw | accepted | 2026-02-20 |
| [0079](0079-telnyx-voice-sms-notification.md) | Telnyx Voice & SMS Notification Channel | shipped | 2026-02-20 |
| [0080](0080-vault-file-access-voice-mode.md) | Vault File Access from Voice Mode | shipped | 2026-02-20 |
| [0081](0081-vault-cli-agent-access.md) | Vault CLI & Agent Tool Access | shipped | 2026-02-20 |
| [0082](0082-typesense-unified-search.md) | Typesense as Unified Search Layer | shipped | 2026-02-20 |
| [0083](0083-tailscale-kubernetes-operator.md) | Tailscale Kubernetes Operator for Service Mesh | proposed | 2026-02-20 |
| [0084](0084-unified-content-resource-schema.md) | Unified Content Resource Schema (Convex) | accepted | 2026-02-21 |
| [0085](0085-data-driven-network-page.md) | Data-Driven Network Page via Convex | accepted | 2026-02-21 |
| [0086](0086-telegram-slash-commands-rich-interactions.md) | Telegram Slash Commands, Channel-Aware Formatting, and Rich Interactions | accepted | 2026-02-21 |
| [0087](0087-observability-pipeline-joelclaw-design-system.md) | Full-Stack Observability + JoelClaw Design System | shipped | 2026-02-21 |
| [0088](0088-nas-backed-storage-tiering.md) | NAS-Backed Storage Tiering | proposed | 2026-02-21 |
| [0089](0089-single-source-inngest-worker-deployment.md) | Single-Source Inngest Worker Deployment (Retire Dual-Clone Sync) | shipped | 2026-02-21 |
| [0090](0090-o11y-triage-loop.md) | Autonomous O11y Triage Loop | shipped | 2026-02-21 |
| [0091](0091-gateway-model-fallback.md) | Gateway Model Fallback | accepted | 2026-02-21 |
| [0092](0092-pi-infer-model-fallback-abstraction.md) | Unified pi-infer Abstraction with Model Fallback | proposed | 2026-02-22 |
| [0093](0093-agent-friendly-navigation-contract.md) | Agent-Friendly Navigation Contract (AGENT-FIRST 30) | accepted | 2026-02-22 |
| [0094](0094-memory-write-gate-soft-llm.md) | Memory Write Gate V1 (Soft, LLM-First, Three-State) | proposed | 2026-02-22 |
| [0095](0095-typesense-native-memory-categories-skos-lite.md) | Typesense-Native Memory Categories (SKOS-Lite V1) | proposed | 2026-02-22 |
| [0096](0096-budget-aware-memory-retrieval.md) | Budget-Aware Memory Retrieval Policy | proposed | 2026-02-22 |
| [0097](0097-forward-triggers-memory-preload.md) | Forward Triggers for Time-Based Memory Preload | proposed | 2026-02-22 |
| [0098](0098-memory-write-gate-v2-calibration.md) | Memory Write Gate V2 Calibration and Governance | proposed | 2026-02-22 |
| [0099](0099-memory-knowledge-graph-substrate.md) | Memory Knowledge-Graph Substrate | deferred | 2026-02-22 |
| [0100](0100-memory-dual-search-activation.md) | Memory Dual Search (Vector + Graph) Activation Plan | deferred | 2026-02-22 |
| [0101](0101-langfuse-llm-only-observability.md) | Langfuse as an LLM-Only Observability Plane | accepted | 2026-02-22 |
| [0102](0102-scheduled-prompt-tasks.md) | Scheduled Prompt Tasks | proposed | 2026-02-22 |
| [0103](0103-gateway-session-isolation.md) | Gateway Session Isolation — No Background Work in the Pi Session | accepted | 2026-02-22 |
| [0104](0104-gateway-priority-message-queue.md) | Gateway Priority Message Queue | proposed | 2026-02-22 |
| [0105](0105-joelclaw-pdf-brain-typesense.md) | joelclaw PDF Brain — Document Library as First-Class Network Utility | proposed | 2026-02-22 |
| [0106](0106-adr-review-pipeline.md) | ADR Review Pipeline — Inline Comments & Agent Update Loop | proposed | 2026-02-22 |
| [0107](0107-adr-convex-migration.md) | ADR Content Migration — Filesystem to Convex Read Projection | proposed | 2026-02-22 |
| [0108](0108-nextjs-best-practices-audit.md) | Next.js Best Practices Audit | proposed | 2026-02-22 |
| [0109](0109-system-wide-taxonomy-concept-contract.md) | System-Wide Taxonomy + Concept Contract (No Tag Soup) | proposed | 2026-02-22 |
| [0110](0110-agent-secrets-lease-dedup-otel.md) | Agent-Secrets Lease Deduplication & OTEL Integration | proposed | 2026-02-22 |
| [0111](0111-email-channel-routing-engine.md) | Channel Routing Engine (Conversations + Events) | proposed | 2026-02-22 |
| [0112](0112-unified-caching-layer.md) | Unified Caching Layer | accepted | 2026-02-23 |
| [0113](0113-standardize-status-indicator.md) | Standardize page-level status indicator styling | accepted | 2026-02-23 |
| [0114](0114-elixir-beam-jido-migration.md) | Elixir/BEAM/Jido Migration — Full Architecture Evaluation | researching | 2026-02-23 |
| [0115](0115-koko-project-charter.md) | Koko — Elixir Agent Project Charter | proposed | 2026-02-23 |
| [0116](0116-koko-redis-bridge-protocol.md) | Koko Redis Bridge Protocol | proposed | 2026-02-23 |
| [0117](0117-koko-first-workloads.md) | Koko First Workloads | proposed | 2026-02-23 |
| [0118](0118-koko-shadow-executor.md) | Koko Shadow Executor Mode | proposed | 2026-02-23 |
