---
type: index
tags:
  - adr
  - decisions
---

# Architecture Decision Records

| ADR | Title | Status | Date |
|-----|-------|--------|------|
| [0001](0001-adopt-architecture-decision-records.md) | Adopt architecture decision records | shipped | 2026-02-14 |
| [0002](0002-personal-assistant-system-architecture.md) | Adopt PARA vault + OpenClaw orchestration for always-on personal assistant | superseded | 2026-02-14 |
| [0003](0003-joelclaw-over-openclaw.md) | Build joelclaw instead of deploying OpenClaw | shipped | 2026-02-14 |
| [0004](0004-atproto-federation-native-app.md) | AT Protocol as bedrock + native iPhone app | shipped | 2026-02-14 |
| [0005](0005-durable-multi-agent-coding-loops.md) | Adopt Inngest multi-agent pipeline for durable autonomous coding loops | shipped | 2026-02-14 |
| [0006](0006-observability-prometheus-grafana.md) | Adopt Prometheus + Grafana for system observability | superseded by 0087 | 2026-02-14 |
| [0007](0007-agent-loop-v2-improvements.md) | Agent Loop V2 Improvements | superseded by 0015, 0016, 0023 | 2026-02-14 |
| [0008](0008-loop-retrospective-and-skill-evolution.md) | Loop Retrospective and Skill Evolution | shipped | 2026-02-14 |
| [0009](0009-rename-igs-cli-to-joelclaw.md) | Rename igs CLI to joelclaw | shipped | 2026-02-15 |
| [0010](0010-system-loop-gateway.md) | System Loop (OpenClaw Gateway) | superseded by 0018 | 2026-02-15 |
| [0011](0011-redis-backed-loop-state.md) | Redis-Backed PRD State for Agent Loops | shipped | 2026-02-14 |
| [0012](0012-planner-generates-prd.md) | Planner Generates PRD from Goal | shipped | 2026-02-14 |
| [0013](0013-llm-judge-evaluation.md) | LLM-Powered Judge Evaluation | superseded | 2026-02-14 |
| [0014](0014-agent-memory-workspace.md) | Agent Memory Workspace | superseded by 0021 | 2026-02-14 |
| [0015](0015-loop-architecture-tdd-roles.md) | Loop Architecture TDD Roles | shipped | 2026-02-14 |
| [0016](0016-loop-idempotency-guards.md) | Loop Idempotency Guards | shipped | 2026-02-14 |
| [0017](0017-parallel-story-execution.md) | Parallel Story Execution | proposed | 2026-02-14 |
| [0018](0018-pi-native-gateway-redis-event-bridge.md) | Pi-native gateway with Redis event bridge | shipped | 2026-02-14 |
| [0019](0019-event-naming-past-tense.md) | Rename events to past-tense notifications | shipped | 2026-02-15 |
| [0020](0020-observational-memory-pipeline.md) | Observational memory pipeline (Observer/Reflector) | superseded by 0021 | 2026-02-15 |
| [0021](0021-agent-memory-system.md) | Comprehensive agent memory system (supersedes 0014, 0020) | shipped | 2026-02-15 |
| [0022](0022-webhook-to-system-event-pipeline.md) | Webhook to system event pipeline | superseded by 0048 | 2026-02-15 |
| [0023](0023-docker-sandbox-for-agent-loops.md) | Docker sandbox for agent loops | shipped | 2026-02-15 |
| [0024](0024-taxonomy-enhanced-session-search.md) | Taxonomy-enhanced session search | superseded | 2026-02-16 |
| [0025](0025-k3s-cluster-for-joelclaw-network.md) | k3s cluster for joelclaw network | shipped | 2026-02-16 |
| [0026](0026-background-agents-via-inngest.md) | Background agents via Inngest | proposed | 2026-02-16 |
| [0027](0027-video-content-pipeline-expansion.md) | Video content pipeline expansion — clip segmentation + content repurposing | proposed | 2026-02-16 |
| [0028](0028-inngest-rig-alignment-with-sdk-skills.md) | Align Inngest rig with SDK best practices | shipped | 2026-02-16 |
| [0029](0029-replace-docker-desktop-with-colima.md) | Replace Docker Desktop + k3d with Colima + Talos | shipped | 2026-02-17 |
| [0030](0030-cilium-cni-kube-proxy-replacement.md) | Replace Flannel + kube-proxy with Cilium | proposed | 2026-02-17 |
| [0031](0031-cilium-gateway-api.md) | Adopt Cilium Gateway API instead of Ingress | proposed | 2026-02-17 |
| [0032](0032-kubernetes-storage-ceph-rook-vs-seaweedfs.md) | K8s persistent storage: Ceph Rook vs SeaweedFS vs local-path | proposed | 2026-02-17 |
| [0033](0033-victoriametrics-grafana-monitoring-stack.md) | VictoriaMetrics + Grafana monitoring stack | superseded by 0087 | 2026-02-17 |
| [0034](0034-flux-operator-gitops.md) | Flux Operator for GitOps cluster management | proposed | 2026-02-17 |
| [0035](0035-gateway-session-routing-central-satellite.md) | Central + satellite session routing for gateway events | shipped | 2026-02-17 |
| [0036](0036-launchd-central-gateway-session.md) | Run central gateway session as a launchd-managed daemon | superseded by 0038 | 2026-02-17 |
| [0037](0037-gateway-watchdog-layered-failure-detection.md) | Layered watchdog for gateway heartbeat failure detection | shipped | 2026-02-17 |
| [0038](0038-embedded-pi-gateway-daemon.md) | Embed pi as a library in a joelclaw gateway daemon | shipped | 2026-02-17 |
| [0039](0039-self-host-convex-for-joelclaw.md) | Self-host Convex as the real-time data layer for joelclaw.com | shipped | 2026-02-18 |
| [0040](0040-google-workspace-via-gogcli.md) | Google Workspace Access via gogcli | shipped | 2026-02-18 |
| [0041](0041-first-class-media-from-channels.md) | First-Class Media Handling from Connected Channels | proposed | 2026-02-18 |
| [0042](0042-telegram-rich-replies-and-outbound-media.md) | Telegram Rich Replies, Outbound Media, and Agent Voice | accepted | 2026-02-18 |
| [0043](0043-agent-voice-conversations.md) | Agent Voice Conversations via Self-Hosted LiveKit | shipped | 2026-02-19 |
| [0044](0044-pds-private-first-with-bento-bridge.md) | Private-First PDS with Bento Bridge | shipped | 2026-02-18 |
| [0045](0045-task-management-ports-and-adapters.md) | Task Management via Ports and Adapters | shipped | 2026-02-18 |
| [0046](0046-things-cli-typescript-port.md) | TypeScript Things CLI via joelclaw Tasks Subcommand | rejected | 2026-02-18 |
| [0047](0047-todoist-as-conversation-channel.md) | Todoist as Async Conversation Channel | shipped | 2026-02-18 |
| [0048](0048-webhook-gateway-system.md) | Webhook Gateway for External Service Integration | shipped | 2026-02-18 |
| [0049](0049-gateway-tui-via-websocket.md) | Gateway TUI via WebSocket | shipped | 2026-02-18 |
| [0050](0050-gateway-session-resume-and-codex-model.md) | Gateway session resume via fixed file path and codex model pinning | shipped | 2026-02-18 |
| [0051](0051-tailscale-funnel-as-public-ingress.md) | Tailscale Funnel as Public Ingress for Webhooks | shipped | 2026-02-18 |
| [0052](0052-email-port-hexagonal-architecture.md) | Email Port — Hexagonal Architecture with Dual Adapters | shipped | 2026-02-18 |
| [0053](0053-event-prompts-and-agent-triage.md) | Event-emitter prompts and the Agency triage principle | shipped | 2026-02-18 |
| [0054](0054-joelclaw-native-app.md) | joelclaw Native App — iPhone, Watch, CarPlay | proposed | 2026-02-19 |
| [0055](0055-granola-meeting-intelligence-pipeline.md) | Granola Meeting Intelligence Pipeline | proposed | 2026-02-19 |
| [0056](0056-personal-relationship-management.md) | Personal Relationship Management — People as First-Class Entities | superseded | 2026-02-19 |
| [0057](0057-skill-pack-distribution.md) | Skill Pack Distribution — Install from Source | shipped | 2026-02-19 |
| [0058](0058-streamed-ndjson-cli-protocol.md) | Streamed NDJSON Protocol for Agent-First CLIs | accepted | 2026-02-19 |
| [0059](0059-multi-language-lsp-extension.md) | Multi-Language LSP Extension for pi-tools | proposed | 2026-02-19 |
| [0060](0060-inngest-swarm-dag-orchestration.md) | Inngest-Backed Swarm/DAG Multi-Agent Orchestration | proposed | 2026-02-19 |
| [0061](0061-pi-tools-enhancement-cycle.md) | pi-tools Enhancement Cycle — Commit Tool, Web Extractors, MCQ | proposed | 2026-02-19 |
| [0087](0087-observability-pipeline-joelclaw-design-system.md) | Full-Stack Observability + JoelClaw Design System | shipped | 2026-02-21 |
| [0088](0088-nas-backed-storage-tiering.md) | NAS-Backed Storage Tiering | shipped | 2026-02-21 |
| [0089](0089-single-source-inngest-worker-deployment.md) | Single-Source Inngest Worker Deployment (Retire Dual-Clone Sync) | shipped | 2026-02-21 |
| [0090](0090-o11y-triage-loop.md) | Autonomous O11y Triage Loop | shipped | 2026-02-21 |
| [0091](0091-gateway-model-fallback.md) | Gateway Model Fallback | shipped | 2026-02-21 |
| [0092](0092-pi-infer-model-fallback-abstraction.md) | Unified pi-infer Abstraction with Model Fallback | proposed | 2026-02-22 |
| [0093](0093-agent-friendly-navigation-contract.md) | Agent-Friendly Navigation Contract (AGENT-FIRST 30) | shipped | 2026-02-22 |
| [0094](0094-memory-write-gate-soft-llm.md) | Memory Write Gate V1 (Soft, LLM-First, Three-State) | proposed | 2026-02-22 |
| [0095](0095-typesense-native-memory-categories-skos-lite.md) | Typesense-Native Memory Categories (SKOS-Lite V1) | proposed | 2026-02-22 |
| [0096](0096-budget-aware-memory-retrieval.md) | Budget-Aware Memory Retrieval Policy | proposed | 2026-02-22 |
| [0097](0097-forward-triggers-memory-preload.md) | Forward Triggers for Time-Based Memory Preload | proposed | 2026-02-22 |
| [0098](0098-memory-write-gate-v2-calibration.md) | Memory Write Gate V2 Calibration and Governance | proposed | 2026-02-22 |
| [0099](0099-memory-knowledge-graph-substrate.md) | Memory Knowledge-Graph Substrate | proposed | 2026-02-22 |
| [0100](0100-memory-dual-search-activation.md) | Memory Dual Search (Vector + Graph) Activation Plan | proposed | 2026-02-22 |
| [0101](0101-langfuse-llm-only-observability.md) | Langfuse as an LLM-Only Observability Plane | superseded | 2026-02-22 |
| [0102](0102-scheduled-prompt-tasks.md) | Scheduled Prompt Tasks | proposed | 2026-02-22 |
| [0103](0103-gateway-session-isolation.md) | Gateway Session Isolation — No Background Work in the Pi Session | shipped | 2026-02-22 |
| [0104](0104-gateway-priority-message-queue.md) | Gateway Priority Message Queue | proposed | 2026-02-22 |
| [0105](0105-joelclaw-pdf-brain-typesense.md) | Joelclaw PDF Brain — Document Library as First-Class Network Utility | proposed | 2026-02-22 |
| [0106](0106-adr-review-pipeline.md) | ADR Review Pipeline — Inline Comments & Agent Update Loop | proposed | 2026-02-22 |
| [0107](0107-adr-convex-migration.md) | ADR Content Migration — Filesystem to Convex Read Projection | proposed | 2026-02-22 |
| [0108](0108-nextjs-best-practices-audit.md) | Next.js Best Practices Audit | shipped | 2026-02-22 |
| [0109](0109-system-wide-taxonomy-concept-contract.md) | System-Wide Taxonomy + Concept Contract (No Tag Soup) | proposed | 2026-02-22 |
| [0120](0120-discord-thread-conversations.md) | Discord Thread-Based Conversations | accepted | 2026-02-23 |
| [0121](0121-imsg-rpc-socket-daemon.md) | iMessage Channel via imsg-rpc FDA Sidecar on macOS | shipped | 2026-02-24 |
| [0122](0122-discord-rich-interactive-messaging.md) | Discord Rich Interactive Messaging | accepted | 2026-02-23 |
| [0123](0123-request-scoped-channel-routing.md) | Request-Scoped Channel Routing | shipped | 2026-02-23 |
| [0124](0124-discord-thread-forked-sessions.md) | Discord Thread-Forked Sessions (Trunk + Branch) | proposed | 2026-02-24 |
| [0125](0125-channel-aware-prompt-injection.md) | Channel-Aware Prompt Injection & Platform Formatting | proposed | 2026-02-24 |
| [0126](0126-discord-rich-ui-component-library.md) | Discord Rich UI Component Library (CV2) | shipped | 2026-02-24 |
| [0127](0127-feed-subscriptions-and-resource-monitoring.md) | Feed Subscriptions & Resource Monitoring | shipped | 2026-02-24 |
| [0128](0128-subagent-delegation-and-chain-execution.md) | Subagent Delegation & Chain Execution for Gateway | proposed | 2026-02-24 |
| [0129](0129-automated-x-posting-strategy.md) | Automated X Posting Strategy | shipped | 2026-02-24 |
| [0130](0130-slack-channel-integration.md) | Slack Channel Integration | accepted | 2026-02-24 |
| [0131](0131-unified-channel-intelligence-pipeline.md) | Unified Channel Intelligence Pipeline | accepted | 2026-02-24 |
| [0132](0132-vip-dm-escalated-handling.md) | VIP DM Escalated Handling | proposed | 2026-02-24 |
| [0133](0133-contact-enrichment-pipeline.md) | Contact Enrichment Pipeline | proposed | 2026-02-24 |
| [0134](0134-system-sleep-mode.md) | System Sleep Mode | proposed | 2026-02-24 |
| [0135](0135-pi-langfuse-instrumentation.md) | Pi Session Langfuse Instrumentation | proposed | 2026-02-25 |
| [0136](0136-twitter-archive-typesense-corpus.md) | Integrate 20-Year Twitter Archive as a Typesense-Backed Corpus | proposed | 2026-02-25 |
| [0140](0140-unified-joelclaw-inference-router.md) | Adopt a unified inference router control plane with OTEL + Langfuse as a single observability sink | shipped | 2026-02-25 |
| [0139](0139-self-healing-sdk-investigator.md) | SDK Reachability Investigator (Historical, Superseded) | superseded by 0138 | 2026-02-25 |
| [0138](0138-self-healing-backup-orchestrator.md) | Self-Healing NAS Backup Orchestrator | shipped | 2026-02-25 |
| [0137](0137-codex-prompting-skill-router.md) | Codex Prompting Skill Router for Intent-to-Tool Delegation | shipped | 2026-02-25 |
| [0154](0154-livekit-voice-worker-durability.md) | LiveKit Voice Worker Durability Contract | accepted | 2026-02-26 |
| [0168](0168-convex-canonical-content-lifecycle.md) | Convex-Canonical Content Lifecycle (No Repo MDX Sources) | accepted | 2026-02-28 |
