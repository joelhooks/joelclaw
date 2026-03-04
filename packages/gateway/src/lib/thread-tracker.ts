/**
 * ADR-0209: Gateway Conversation Thread Tracker
 *
 * Channel-agnostic thread tracking for the gateway session.
 * Thread detection via haiku classifier + channel reply-to hard signals.
 * Each channel provides its own message anchor type (Telegram message ID,
 * Discord message ID, Slack thread_ts, etc).
 *
 * Lifecycle: active (2h) → warm (24h) → cool (72h) → archived
 */

// ── Types ───────────────────────────────────────────────

/** Opaque channel message anchor — each channel defines its own shape */
export type MessageAnchor = string;

/** Channel-qualified anchor: "telegram:12345", "discord:98765432" */
function qualifyAnchor(channel: string, anchor: MessageAnchor): string {
  return `${channel}:${anchor}`;
}

export interface Thread {
  id: string;
  label: string;
  createdAt: number;
  lastTouchedAt: number;
  lastSummary: string;
  messageCount: number;
  /** Last message anchor per channel (for reply-to) */
  lastAnchors: Record<string, MessageAnchor>;
  lifecycle: "active" | "warm" | "cool" | "archived";
}

export interface ThreadClassification {
  threadId: string;
  threadLabel: string;
  isNew: boolean;
  confidence: number;
  /** Source of classification */
  source: "haiku" | "reply-to" | "continuation";
}

export interface ThreadIndex {
  threads: Thread[];
  activeCount: number;
  warmCount: number;
}

// ── Configuration ───────────────────────────────────────
const ACTIVE_THRESHOLD_MS = 2 * 60 * 60 * 1000;   // 2h
const WARM_THRESHOLD_MS = 24 * 60 * 60 * 1000;     // 24h
const COOL_THRESHOLD_MS = 72 * 60 * 60 * 1000;     // 72h

// ── State ───────────────────────────────────────────────
const threads = new Map<string, Thread>();
/** "channel:anchorId" → threadId */
const anchorThreadMap = new Map<string, string>();

let threadCounter = 0;

// ── Thread ID generation ────────────────────────────────
function generateThreadId(): string {
  threadCounter++;
  const ts = Date.now().toString(36);
  return `t-${ts}-${threadCounter}`;
}

// ── Lifecycle management ────────────────────────────────
function computeLifecycle(lastTouchedAt: number, now: number): Thread["lifecycle"] {
  const age = now - lastTouchedAt;
  if (age < ACTIVE_THRESHOLD_MS) return "active";
  if (age < WARM_THRESHOLD_MS) return "warm";
  if (age < COOL_THRESHOLD_MS) return "cool";
  return "archived";
}

export function updateLifecycles(): Thread[] {
  const now = Date.now();
  const archived: Thread[] = [];

  for (const thread of threads.values()) {
    const newLifecycle = computeLifecycle(thread.lastTouchedAt, now);
    if (newLifecycle === "archived" && thread.lifecycle !== "archived") {
      archived.push({ ...thread });
    }
    thread.lifecycle = newLifecycle;
  }

  for (const thread of archived) {
    threads.delete(thread.id);
  }

  return archived;
}

// ── Thread operations ───────────────────────────────────
export function createThread(
  label: string,
  channel?: string,
  messageAnchor?: MessageAnchor,
): Thread {
  const id = generateThreadId();
  const now = Date.now();
  const lastAnchors: Record<string, MessageAnchor> = {};

  if (channel && messageAnchor) {
    lastAnchors[channel] = messageAnchor;
    anchorThreadMap.set(qualifyAnchor(channel, messageAnchor), id);
  }

  const thread: Thread = {
    id,
    label,
    createdAt: now,
    lastTouchedAt: now,
    lastSummary: "",
    messageCount: 1,
    lastAnchors,
    lifecycle: "active",
  };
  threads.set(id, thread);
  return thread;
}

export function touchThread(
  threadId: string,
  channel?: string,
  messageAnchor?: MessageAnchor,
): Thread | null {
  const thread = threads.get(threadId);
  if (!thread) return null;

  thread.lastTouchedAt = Date.now();
  thread.messageCount++;
  thread.lifecycle = "active";

  if (channel && messageAnchor) {
    thread.lastAnchors[channel] = messageAnchor;
    anchorThreadMap.set(qualifyAnchor(channel, messageAnchor), threadId);
  }

  return thread;
}

/**
 * Record an outbound message anchor so future reply-to can resolve it.
 */
export function recordOutboundAnchor(
  threadId: string,
  channel: string,
  messageAnchor: MessageAnchor,
): void {
  const thread = threads.get(threadId);
  if (thread) {
    thread.lastAnchors[channel] = messageAnchor;
  }
  anchorThreadMap.set(qualifyAnchor(channel, messageAnchor), threadId);
}

/**
 * Resolve a reply-to anchor to its thread.
 */
export function getThreadForAnchor(channel: string, messageAnchor: MessageAnchor): string | null {
  return anchorThreadMap.get(qualifyAnchor(channel, messageAnchor)) ?? null;
}

/**
 * Get the last message anchor for a thread on a specific channel.
 * Used to set reply-to on outbound messages.
 */
export function getLastAnchor(threadId: string, channel: string): MessageAnchor | null {
  const thread = threads.get(threadId);
  return thread?.lastAnchors[channel] ?? null;
}

export function getThread(threadId: string): Thread | null {
  return threads.get(threadId) ?? null;
}

export function getActiveThreads(): Thread[] {
  return [...threads.values()]
    .filter((t) => t.lifecycle === "active")
    .sort((a, b) => b.lastTouchedAt - a.lastTouchedAt);
}

export function getAllThreads(): Thread[] {
  return [...threads.values()]
    .sort((a, b) => b.lastTouchedAt - a.lastTouchedAt);
}

// ── Thread index for prompt injection ───────────────────
export function buildThreadIndex(): ThreadIndex {
  updateLifecycles();
  const all = getAllThreads();
  return {
    threads: all,
    activeCount: all.filter((t) => t.lifecycle === "active").length,
    warmCount: all.filter((t) => t.lifecycle === "warm").length,
  };
}

export function formatThreadIndexForPrompt(): string {
  const index = buildThreadIndex();
  if (index.threads.length === 0) return "";

  const lines: string[] = ["## Active Conversation Threads"];

  const emoji: Record<string, string> = {
    active: "🔵",
    warm: "🟡",
    cool: "⚪",
  };

  for (const t of index.threads) {
    if (t.lifecycle === "archived") continue;
    const age = formatAge(t.lastTouchedAt);
    const e = emoji[t.lifecycle] ?? "⚪";
    const summary = t.lastSummary ? ` — ${t.lastSummary}` : "";

    if (t.lifecycle === "cool") {
      // Cool threads: label only, no summary
      lines.push(`- ${e} ${t.label} (${age})`);
    } else {
      lines.push(`- ${e} **${t.label}**${summary} (${age}, ${t.messageCount} msgs)`);
    }
  }

  return lines.join("\n");
}

function formatAge(ts: number): string {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// ── Haiku thread classifier prompt ──────────────────────
export function buildClassifierPrompt(
  userMessage: string,
  activeThreads: Thread[],
): string {
  const threadList = activeThreads.length > 0
    ? activeThreads.map((t) =>
      `- id: "${t.id}", label: "${t.label}", last: "${t.lastSummary || "(no summary)"}"`,
    ).join("\n")
    : "(no active threads)";

  return `You are a conversation thread classifier. Given a user message and the list of active conversation threads, determine which thread this message belongs to, or if it starts a new thread.

Active threads:
${threadList}

User message:
"${userMessage.slice(0, 500)}"

Respond with JSON only, no explanation:
{
  "threadId": "<existing thread id or 'new'>",
  "label": "<short 2-5 word label for new thread, or existing label>",
  "confidence": <0.0-1.0>
}

Rules:
- If the message clearly continues an existing thread, return its id
- If the message starts a new topic, return "new"
- If ambiguous, prefer the most recently active thread (confidence < 0.7)
- Labels should be kebab-case-friendly: "restate-eval", "minio-deploy", "memory-pipeline"`;
}

export interface ClassifierResult {
  threadId: string;
  label: string;
  confidence: number;
}

export function parseClassifierResponse(raw: string): ClassifierResult | null {
  try {
    const cleaned = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    const threadId = typeof parsed.threadId === "string" ? parsed.threadId : null;
    const label = typeof parsed.label === "string" ? parsed.label : null;
    const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0.5;

    if (!threadId || !label) return null;
    return { threadId, label, confidence };
  } catch {
    return null;
  }
}

// ── Classification pipeline ─────────────────────────────
/**
 * Classify via channel reply-to anchor.
 * Returns null if anchor not found (fall through to haiku).
 */
export function classifyByReplyTo(
  channel: string,
  replyToAnchor: MessageAnchor,
): ThreadClassification | null {
  const threadId = getThreadForAnchor(channel, replyToAnchor);
  if (!threadId) return null;

  const thread = threads.get(threadId);
  if (!thread) return null;

  return {
    threadId: thread.id,
    threadLabel: thread.label,
    isNew: false,
    confidence: 1.0,
    source: "reply-to",
  };
}

/**
 * Classify from haiku result.
 */
export function classifyByHaikuResult(
  result: ClassifierResult,
): ThreadClassification {
  if (result.threadId === "new") {
    return {
      threadId: "new",
      threadLabel: result.label,
      isNew: true,
      confidence: result.confidence,
      source: "haiku",
    };
  }

  const thread = threads.get(result.threadId);
  if (!thread) {
    return {
      threadId: "new",
      threadLabel: result.label,
      isNew: true,
      confidence: result.confidence * 0.5,
      source: "haiku",
    };
  }

  return {
    threadId: thread.id,
    threadLabel: thread.label,
    isNew: false,
    confidence: result.confidence,
    source: "haiku",
  };
}

/**
 * Resolve classification → create or touch thread.
 * Returns the thread and the channel anchor to reply-to (if continuing).
 */
export function resolveClassification(
  classification: ThreadClassification,
  channel?: string,
  inboundAnchor?: MessageAnchor,
): { thread: Thread; replyToAnchor: MessageAnchor | null } {
  if (classification.isNew) {
    const thread = createThread(classification.threadLabel, channel, inboundAnchor);
    return { thread, replyToAnchor: null };
  }

  const thread = touchThread(classification.threadId, channel, inboundAnchor);
  if (!thread) {
    const newThread = createThread(classification.threadLabel, channel, inboundAnchor);
    return { thread: newThread, replyToAnchor: null };
  }

  // For continuations, reply-to the last message in this thread on this channel
  const lastAnchor = channel ? (thread.lastAnchors[channel] ?? null) : null;
  return {
    thread,
    replyToAnchor: lastAnchor,
  };
}

// ── Persistence (for compaction survival) ───────────────
export function getThreadsSnapshot(): Thread[] {
  return [...threads.values()].map((t) => ({ ...t }));
}

export function restoreThreads(snapshot: Thread[]): void {
  threads.clear();
  for (const t of snapshot) {
    threads.set(t.id, { ...t });
    // Rebuild anchor map from thread state
    for (const [ch, anchor] of Object.entries(t.lastAnchors)) {
      anchorThreadMap.set(qualifyAnchor(ch, anchor), t.id);
    }
  }
}

// ── Reset (testing) ─────────────────────────────────────
export function resetAllThreads(): void {
  threads.clear();
  anchorThreadMap.clear();
  threadCounter = 0;
}
