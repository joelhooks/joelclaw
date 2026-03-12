const HEARTBEAT_OK_PREFIX = /^HEARTBEAT_OK\b[\s.:;,!\-–—]*/u;

const SUPPRESSED_TYPES = new Set([
  "todoist.task.completed",
  "memory.observed",
  "content.synced",
  "media/received",
  "progress",
  "test.gateway-e2e",
]);

const DEFAULT_BATCHED_TYPES = new Set([
  "cron.heartbeat",
  "todoist.task.created",
  "todoist.task.deleted",
  "front.message.received",
  "front.message.sent",
  "front.assignee.changed",
  "vercel.deploy.succeeded",
  "vercel.deploy.created",
  "vercel.deploy.canceled",
  "discovery.captured",
  "meeting.analyzed",
]);

const ACTIONABLE_PATTERNS = [
  /\bneed(s|ed)?\b/iu,
  /\bhelp\b/iu,
  /\bshould\b/iu,
  /\bmust\b/iu,
  /\bblocked?\b/iu,
  /\burgent\b/iu,
  /\bdeadline\b/iu,
  /\bapprove\b/iu,
  /\breply\b/iu,
  /\bschedule\b/iu,
  /\bpricing\b/iu,
  /\blaunch\b/iu,
  /\btitle\b/iu,
  /\bteaser\b/iu,
  /\bmembership\b/iu,
  /\blink swap\b/iu,
  /\bdecision\b/iu,
  /\bquestion(s)? for joel\b/iu,
  /\bwhat do you think\b/iu,
];

const LOW_SIGNAL_PATTERNS = [
  /\bno action needed\b/iu,
  /\bnothing anomalous\b/iu,
  /\bnoted\b/iu,
  /\bsystem healthy\b/iu,
  /\balready got it\b/iu,
  /\balready have it\b/iu,
];

const PROJECT_RULES = [
  { key: "ai-hero", patterns: [/\bai hero\b/iu, /\bcohort\b/iu, /\bmembership\b/iu] },
  { key: "gremlin", patterns: [/\bgremlin\b/iu, /#project-gremlin\b/iu] },
  { key: "joelclaw", patterns: [/\bjoelclaw\b/iu, /\bgateway\b/iu, /\bpi tools\b/iu, /\bpi-tools\b/iu] },
  { key: "egghead", patterns: [/\begghead\b/iu, /\bkit\b/iu] },
  { key: "course-builder", patterns: [/\bcourse-builder\b/iu, /\btotal typescript\b/iu, /\bepic ai\b/iu] },
  { key: "badass-dev", patterns: [/\bbadass\.dev\b/iu, /\bbadass dev\b/iu] },
  { key: "vercel", patterns: [/\bvercel\b/iu] },
];

export type OperatorRelayEvent = {
  type: string;
  source: string;
  payload: Record<string, unknown>;
  ts?: number;
};

export type OperatorSignalBucket = "immediate" | "batched" | "suppressed";

export type OperatorSignalDecision = {
  bucket: OperatorSignalBucket;
  reason: string;
  score: number;
  summary: string;
  projectKeys: string[];
  contactKeys: string[];
  correlationKeys: string[];
};

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function collectTags(payload: Record<string, unknown>): string[] {
  const raw = payload.tags;
  if (!Array.isArray(raw)) return [];
  return raw.map((tag) => normalizeText(tag)).filter(Boolean);
}

function buildEventText(event: OperatorRelayEvent): string {
  const payload = event.payload ?? {};
  return [
    normalizeText(payload.prompt),
    normalizeText(payload.subject),
    normalizeText(payload.preview),
    normalizeText(payload.fromName),
    normalizeText(payload.from),
    normalizeText(payload.status),
    ...collectTags(payload),
  ].filter(Boolean).join("\n");
}

function extractProjectKeys(text: string): string[] {
  const matches: string[] = [];
  for (const rule of PROJECT_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(text))) {
      matches.push(rule.key);
    }
  }
  return dedupe(matches);
}

function extractContactKeys(event: OperatorRelayEvent): string[] {
  const payload = event.payload ?? {};
  const contacts: string[] = [];
  const from = normalizeText(payload.from);
  const fromName = normalizeText(payload.fromName);
  if (from) contacts.push(`email:${normalizeKey(from)}`);
  if (fromName) contacts.push(`person:${normalizeKey(fromName)}`);

  const conversationId = normalizeText(payload.conversationId);
  if (conversationId) contacts.push(`conversation:${conversationId}`);

  const slackChannelId = normalizeText(payload.slackChannelId);
  if (slackChannelId) contacts.push(`slack-channel:${slackChannelId}`);

  const slackThreadTs = normalizeText(payload.slackThreadTs);
  if (slackThreadTs) contacts.push(`slack-thread:${normalizeKey(slackThreadTs)}`);

  return dedupe(contacts);
}

function firstSignalSentence(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  const firstLine = cleaned.split(/\n+/)[0]?.trim() ?? cleaned;
  const sentence = firstLine.split(/(?<=[.!?])\s+/u)[0]?.trim() ?? firstLine;
  return sentence.length > 220 ? `${sentence.slice(0, 217)}…` : sentence;
}

function buildSignalSummary(event: OperatorRelayEvent, text: string): string {
  const payload = event.payload ?? {};
  const subject = normalizeText(payload.subject);
  const from = normalizeText(payload.fromName) || normalizeText(payload.from);

  if (event.type === "vip.email.received") {
    const bits = ["VIP email"];
    if (from) bits.push(`from ${from}`);
    if (subject) bits.push(`— ${subject}`);
    return bits.join(" ");
  }

  if (event.type === "front.message.received") {
    const bits = ["Email"];
    if (from) bits.push(`from ${from}`);
    if (subject) bits.push(`— ${subject}`);
    return bits.join(" ");
  }

  if (event.source.startsWith("slack-intel:")) {
    const channel = event.source.slice("slack-intel:".length);
    const sentence = firstSignalSentence(text);
    return sentence ? `Slack ${channel}: ${sentence}` : `Slack ${channel}`;
  }

  const sentence = firstSignalSentence(text);
  return sentence || `${event.type} (${event.source})`;
}

function computeSignalScore(event: OperatorRelayEvent, text: string, projectKeys: string[]): number {
  const payload = event.payload ?? {};
  let score = 0;

  if (event.type === "vip.email.received") score += 7;
  if (event.type === "front.message.received") score += 2;
  if (event.source.startsWith("slack-intel:")) score += 2;
  if (payload.joelSignal === true) score += 1;
  if (payload.immediateTelegram === true) score += 10;
  if (payload.newsletter === true) score -= 4;
  if (payload.archived === true) score -= 2;

  for (const pattern of ACTIONABLE_PATTERNS) {
    if (pattern.test(text)) score += 2;
  }

  if (text.includes("?")) score += 1;
  if (projectKeys.length > 0) score += 1;

  for (const pattern of LOW_SIGNAL_PATTERNS) {
    if (pattern.test(text)) score -= 3;
  }

  return score;
}

function isInteractiveEvent(event: OperatorRelayEvent): boolean {
  return event.type === "telegram.message.received"
    || event.type === "imessage.message.received"
    || event.type === "slack.message.received"
    || event.type === "discord.message.received"
    || event.type === "approval.requested"
    || event.type === "approval.resolved"
    || event.type === "gateway/sleep"
    || event.type === "gateway/wake";
}

function isDegradationOrErrorEvent(event: OperatorRelayEvent): boolean {
  const payload = event.payload ?? {};
  const level = normalizeText(payload.level).toLowerCase();
  if (level === "error" || level === "fatal") return true;
  if (payload.immediateTelegram === true) return true;

  const type = event.type.toLowerCase();
  return type.includes("degraded")
    || type.includes("fatal")
    || type.includes("error")
    || type.includes("failed")
    || type.includes("drift")
    || type === "alert";
}

function isAutomationSource(source: string): boolean {
  const normalized = source.trim().toLowerCase();
  return normalized.startsWith("inngest/") || normalized === "restate" || normalized.startsWith("restate/");
}

export function normalizeOperatorRelayText(source: string | undefined, text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (source === "heartbeat") return trimmed;

  const normalized = trimmed.replace(HEARTBEAT_OK_PREFIX, "").trim();
  return normalized || trimmed;
}

export function classifyOperatorSignal(
  event: OperatorRelayEvent,
  options?: { quietHours?: boolean },
): OperatorSignalDecision {
  const text = buildEventText(event);
  const projectKeys = extractProjectKeys(text);
  const contactKeys = extractContactKeys(event);
  const correlationKeys = dedupe([
    ...projectKeys.map((key) => `project:${key}`),
    ...contactKeys,
  ]);
  const summary = buildSignalSummary(event, text);
  const score = computeSignalScore(event, text, projectKeys);

  if (SUPPRESSED_TYPES.has(event.type)) {
    return { bucket: "suppressed", reason: "suppressed.type-listed", score, summary, projectKeys, contactKeys, correlationKeys };
  }

  if (isInteractiveEvent(event) || isDegradationOrErrorEvent(event)) {
    return { bucket: "immediate", reason: "immediate.interactive-or-error", score: Math.max(score, 10), summary, projectKeys, contactKeys, correlationKeys };
  }

  if (event.type === "vip.email.received") {
    return { bucket: "immediate", reason: "immediate.vip-email", score: Math.max(score, 7), summary, projectKeys, contactKeys, correlationKeys };
  }

  if (score <= -2) {
    return { bucket: "suppressed", reason: "suppressed.low-signal", score, summary, projectKeys, contactKeys, correlationKeys };
  }

  if ((options?.quietHours ?? false) && score < 5) {
    return { bucket: "batched", reason: "batched.quiet-hours", score, summary, projectKeys, contactKeys, correlationKeys };
  }

  if (score >= 5) {
    return { bucket: "immediate", reason: "immediate.signal-score", score, summary, projectKeys, contactKeys, correlationKeys };
  }

  if (event.source.startsWith("slack-intel:")) {
    return { bucket: "batched", reason: "batched.slack-passive-intel", score, summary, projectKeys, contactKeys, correlationKeys };
  }

  if (DEFAULT_BATCHED_TYPES.has(event.type)) {
    return { bucket: "batched", reason: "batched.type-listed", score, summary, projectKeys, contactKeys, correlationKeys };
  }

  if (isAutomationSource(event.source)) {
    return { bucket: "batched", reason: "batched.automation-source", score, summary, projectKeys, contactKeys, correlationKeys };
  }

  return { bucket: "immediate", reason: "immediate.default-fallback", score, summary, projectKeys, contactKeys, correlationKeys };
}

export function isImmediateOperatorPriorityEvent(event: OperatorRelayEvent): boolean {
  return classifyOperatorSignal(event).bucket === "immediate";
}

function formatCorrelationGroupLabel(key: string): string {
  return key.replace(/^project:/, "").replace(/^person:/, "person:").replace(/^email:/, "email:");
}

export function buildSignalDigestPrompt(events: OperatorRelayEvent[]): string {
  const decisions = events
    .map((event) => ({ event, decision: classifyOperatorSignal(event) }))
    .filter(({ decision }) => decision.bucket !== "suppressed");

  if (decisions.length === 0) return "";

  const grouped = new Map<string, string[]>();
  for (const item of decisions) {
    const groupKey = item.decision.correlationKeys[0] ?? `misc:${item.event.type}`;
    const group = grouped.get(groupKey) ?? [];
    group.push(`- ${item.decision.summary}`);
    grouped.set(groupKey, group);
  }

  const ts = new Date().toLocaleString("sv-SE", { timeZone: "America/Los_Angeles" }).replace(" ", "T") + " PST";
  const parts = [
    `## 🔔 Signal Digest — ${ts}`,
    "",
    `Correlated signals: ${decisions.length}`,
    "",
    "Rules:",
    "- Correlate email and Slack items that touch the same project or person.",
    "- Lead with what needs Joel input or changes project state.",
    "- Never answer with HEARTBEAT_OK, 'noted', or generic system-health filler.",
    "- If nothing needs action, say exactly: No operator action needed.",
  ];

  for (const [groupKey, lines] of grouped.entries()) {
    parts.push("", `### ${formatCorrelationGroupLabel(groupKey)}`, ...lines.slice(0, 6));
  }

  return parts.join("\n");
}

export function buildSignalRelayGuidance(events: OperatorRelayEvent[]): string {
  const decisions = events
    .map((event) => classifyOperatorSignal(event))
    .filter((decision) => decision.bucket !== "suppressed");

  if (decisions.length === 0) {
    return "Take action on anything that needs it, otherwise acknowledge briefly.";
  }

  const correlationHints = dedupe(decisions.flatMap((decision) => decision.correlationKeys)).slice(0, 6);
  const lines = [
    "Operator relay rules:",
    "- Treat Slack/email/project signals as operator briefs, not logs.",
    "- Lead with what needs Joel input or changes project state.",
    "- Correlate related items before replying.",
    "- Never answer with HEARTBEAT_OK, 'noted', or generic gateway status filler.",
    "- If nothing needs action, say exactly: No operator action needed.",
  ];

  if (correlationHints.length > 0) {
    lines.push("- Correlation hints: " + correlationHints.join(", "));
  }

  return lines.join("\n");
}
