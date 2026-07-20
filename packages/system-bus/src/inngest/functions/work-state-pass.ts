import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NonRetriableError, RetryAfterError } from "inngest";
import { getRedisClient } from "../../lib/redis";
import { emitOtelEvent } from "../../observability/emit";
import { inngest } from "../client";

const COMPONENT = "work-state-pass";
const JOEL_SLACK_USER_ID = "U030BJ3CK";
const STARTED_REACTION = "shitrat";
const SHIPPED_REACTION = "white_check_mark";
const DEFAULT_CHANNELS = [
  { id: "C0211NSK3TP", name: "cc-matt-p" },
  { id: "C09LKT871PE", name: "brain-joel" },
] as const;
const DEFAULT_UNTAGGED_AFTER_HOURS = 4;
const DEFAULT_STARTED_STALE_AFTER_DAYS = 7;
const DEFAULT_HISTORY_LIMIT = 200;
const RESERVED_WAKE_TTL_MS = 15 * 60_000;
const WORK_STATE_PASS_CRON = "17 * * * *";

export type WorkState = "untagged" | "started" | "shipped";
export type FindingKind = "untagged" | "stale_started";

export type WorkStateChannel = {
  id: string;
  name: string;
};

export type WorkStatePassConfig = {
  enabled: boolean;
  channels: WorkStateChannel[];
  untaggedAfterHours: number;
  startedStaleAfterDays: number;
  historyLimit: number;
  observationsDir: string;
  notifiedStatePath: string;
  lastRunPath: string;
  wakeMode: "notify" | "off";
  seededProofEnabled: boolean;
};

export type SlackReaction = {
  name?: string;
  count?: number;
  users?: string[];
};

export type SlackRoot = {
  ts?: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  app_id?: string;
  subtype?: string;
  text?: string;
  reactions?: SlackReaction[];
};

type SlackHistoryResponse = {
  ok: boolean;
  error?: string;
  messages?: SlackRoot[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
};

type SlackUserInfoResponse = {
  ok: boolean;
  error?: string;
  user?: {
    name?: string;
    real_name?: string;
    profile?: { display_name?: string; real_name?: string };
  };
};

export type WorkStateFinding = {
  key: string;
  kind: FindingKind;
  channelId: string;
  channelName: string;
  rootTs: string;
  authorId: string;
  authorLabel: string | null;
  workState: Exclude<WorkState, "shipped">;
  ageHours: number;
  thresholdHours: number;
  permalink: string;
  provenance: "slack.conversations.history" | "seeded-proof";
};

export type ChannelScanResult = {
  channel: WorkStateChannel;
  rootsSeen: number;
  requestRootsSeen: number;
  findings: WorkStateFinding[];
  historyTruncated: boolean;
  provenance: "slack.conversations.history" | "seeded-proof";
};

export type WorkStatePassLastRun = {
  version: 1;
  status: "completed" | "failed" | "skipped";
  runId: string;
  trigger: string;
  startedAt: string;
  completedAt: string;
  enabled: boolean;
  seededScenario: boolean;
  channelsScanned: number;
  channelIds: string[];
  rootsSeen: number;
  requestRootsSeen: number;
  findings: number;
  findingKinds: Record<FindingKind, number>;
  pages: number;
  pagePath: string | null;
  newFindings: number;
  wakes: number;
  historyTruncatedChannels: string[];
  error?: string;
};

export type NotifiedState = {
  version: 1;
  updatedAt: string;
  runId: string;
  notified: Record<string, {
    notifiedAt: string;
    kind: FindingKind;
    workState: WorkState;
    status: "reserved" | "notified";
    runId: string;
    deliveryEventId?: string;
  }>;
};

type CommandResult = { stdout: string; stderr: string };

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new NonRetriableError(`Invalid boolean value: ${value}`);
}

function positiveNumber(value: string | undefined, fallback: number, name: string): number {
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new NonRetriableError(`${name} must be a positive number`);
  }
  return parsed;
}

function expandHome(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return trimmed;
}

function parseChannels(raw: string | undefined): WorkStateChannel[] {
  if (!raw?.trim()) return DEFAULT_CHANNELS.map((channel) => ({ ...channel }));
  const channels = raw.split(",").map((entry) => {
    const [idPart, ...nameParts] = entry.trim().split(":");
    const id = idPart?.trim() ?? "";
    const name = nameParts.join(":").trim() || id;
    if (!/^[A-Z][A-Z0-9]{8,}$/u.test(id)) {
      throw new NonRetriableError(`Invalid Slack channel ID in WORK_STATE_PASS_CHANNELS: ${id}`);
    }
    return { id, name: safeLabel(name, 80) || id };
  });
  const unique = new Map(channels.map((channel) => [channel.id, channel]));
  if (unique.size === 0) {
    throw new NonRetriableError("WORK_STATE_PASS_CHANNELS must contain at least one channel");
  }
  return [...unique.values()];
}

export function resolveWorkStatePassConfig(
  env: NodeJS.ProcessEnv = process.env,
): WorkStatePassConfig {
  const historyLimit = Math.floor(
    positiveNumber(env.WORK_STATE_PASS_HISTORY_LIMIT, DEFAULT_HISTORY_LIMIT, "WORK_STATE_PASS_HISTORY_LIMIT"),
  );
  if (historyLimit > 200) {
    throw new NonRetriableError("WORK_STATE_PASS_HISTORY_LIMIT must be <= 200");
  }
  const wakeModeRaw = (env.WORK_STATE_PASS_WAKE_MODE ?? "notify").trim().toLowerCase();
  if (wakeModeRaw !== "notify" && wakeModeRaw !== "off") {
    throw new NonRetriableError("WORK_STATE_PASS_WAKE_MODE must be notify or off");
  }
  return {
    enabled: parseBoolean(env.WORK_STATE_PASS_ENABLED, false),
    channels: parseChannels(env.WORK_STATE_PASS_CHANNELS),
    untaggedAfterHours: positiveNumber(
      env.WORK_STATE_PASS_UNTAGGED_AFTER_HOURS,
      DEFAULT_UNTAGGED_AFTER_HOURS,
      "WORK_STATE_PASS_UNTAGGED_AFTER_HOURS",
    ),
    startedStaleAfterDays: positiveNumber(
      env.WORK_STATE_PASS_STARTED_STALE_AFTER_DAYS,
      DEFAULT_STARTED_STALE_AFTER_DAYS,
      "WORK_STATE_PASS_STARTED_STALE_AFTER_DAYS",
    ),
    historyLimit,
    observationsDir: expandHome(
      env.WORK_STATE_PASS_OBSERVATIONS_DIR ?? "~/.brain/observations",
    ),
    notifiedStatePath: expandHome(
      env.WORK_STATE_PASS_STATE_PATH ?? "~/.joelclaw/work-state-pass.json",
    ),
    lastRunPath: expandHome(
      env.WORK_STATE_PASS_LAST_RUN_PATH ?? "~/.joelclaw/work-state-pass-last-run.json",
    ),
    wakeMode: wakeModeRaw,
    seededProofEnabled: parseBoolean(env.WORK_STATE_PASS_SEEDED_PROOF_ENABLED, false),
  };
}

function hasJoelReaction(root: SlackRoot, reactionName: string): boolean {
  return (root.reactions ?? []).some(
    (reaction) => reaction.name === reactionName && (reaction.users ?? []).includes(JOEL_SLACK_USER_ID),
  );
}

export function workStateForRoot(root: SlackRoot): WorkState {
  if (hasJoelReaction(root, SHIPPED_REACTION)) return "shipped";
  if (hasJoelReaction(root, STARTED_REACTION)) return "started";
  return "untagged";
}

const NON_REQUEST_SUBTYPES = new Set([
  "bot_message",
  "channel_archive",
  "channel_join",
  "channel_leave",
  "channel_name",
  "channel_purpose",
  "channel_topic",
  "group_archive",
  "group_join",
  "group_leave",
  "group_name",
  "group_purpose",
  "group_topic",
  "message_deleted",
  "message_replied",
  "message_changed",
  "tombstone",
]);

export function isNonJoelHumanRoot(root: SlackRoot): boolean {
  const ts = root.ts?.trim();
  const user = root.user?.trim();
  if (!ts || !user || user === JOEL_SLACK_USER_ID) return false;
  if (root.thread_ts?.trim() && root.thread_ts?.trim() !== ts) return false;
  if (root.bot_id?.trim() || root.app_id?.trim()) return false;
  if (root.subtype && NON_REQUEST_SUBTYPES.has(root.subtype)) return false;
  return Number.isFinite(Number.parseFloat(ts));
}

function permalinkFor(channelId: string, ts: string): string {
  return `https://eggheadio.slack.com/archives/${channelId}/p${ts.replace(".", "")}`;
}

function findingKey(
  channelId: string,
  rootTs: string,
  kind: FindingKind,
  workState: WorkState,
): string {
  return `${channelId}:${rootTs}:${kind}:${workState}`;
}

function deliveryEventId(findings: WorkStateFinding[]): string {
  const bytes = createHash("sha256")
    .update(`work-state-pass\n${findings.map((finding) => finding.key).sort().join("\n")}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function classifyChannelRoots(params: {
  channel: WorkStateChannel;
  roots: SlackRoot[];
  nowMs: number;
  untaggedAfterHours: number;
  startedStaleAfterDays: number;
  provenance?: ChannelScanResult["provenance"];
  historyTruncated?: boolean;
}): ChannelScanResult {
  const provenance = params.provenance ?? "slack.conversations.history";
  const findings: WorkStateFinding[] = [];
  let requestRootsSeen = 0;
  for (const root of params.roots) {
    if (!isNonJoelHumanRoot(root)) continue;
    requestRootsSeen += 1;
    const rootTs = root.ts!.trim();
    const createdAtMs = Number.parseFloat(rootTs) * 1000;
    const ageHours = Math.max(0, (params.nowMs - createdAtMs) / 3_600_000);
    const workState = workStateForRoot(root);
    let kind: FindingKind | null = null;
    let thresholdHours = 0;
    if (workState === "untagged" && ageHours > params.untaggedAfterHours) {
      kind = "untagged";
      thresholdHours = params.untaggedAfterHours;
    } else if (
      workState === "started" &&
      ageHours > params.startedStaleAfterDays * 24
    ) {
      kind = "stale_started";
      thresholdHours = params.startedStaleAfterDays * 24;
    }
    if (!kind || workState === "shipped") continue;
    const authorId = root.user!.trim();
    findings.push({
      key: findingKey(params.channel.id, rootTs, kind, workState),
      kind,
      channelId: params.channel.id,
      channelName: params.channel.name,
      rootTs,
      authorId,
      authorLabel: null,
      workState,
      ageHours: Number(ageHours.toFixed(2)),
      thresholdHours,
      permalink: permalinkFor(params.channel.id, rootTs),
      provenance,
    });
  }
  return {
    channel: params.channel,
    rootsSeen: params.roots.length,
    requestRootsSeen,
    findings,
    historyTruncated: params.historyTruncated ?? false,
    provenance,
  };
}

function safeLabel(value: string, maxLength: number): string {
  return value
    .replace(/[{}<>`\[\]\\]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength);
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 96) || randomUUID();
}

function atomicWrite(path: string, value: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tempPath, value, { mode });
  renameSync(tempPath, path);
}

async function runCommand(
  command: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<CommandResult> {
  const dir = mkdtempSync(join(tmpdir(), "work-state-pass-"));
  const stdoutPath = join(dir, "stdout");
  const stderrPath = join(dir, "stderr");
  try {
    const child = Bun.spawn([command, ...args], {
      env: process.env,
      stdin: "ignore",
      stdout: Bun.file(stdoutPath),
      stderr: Bun.file(stderrPath),
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    const exitCode = await child.exited;
    clearTimeout(timer);
    const stdout = readFileSync(stdoutPath, "utf8");
    const stderr = readFileSync(stderrPath, "utf8");
    if (timedOut) throw new Error(`${command} timed out after ${timeoutMs}ms`);
    if (exitCode !== 0) {
      throw new Error(`${command} exited ${exitCode}: ${stderr.trim().slice(0, 500)}`);
    }
    return { stdout, stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function leaseSlackUserToken(): Promise<string> {
  try {
    const result = await runCommand("secrets", ["lease", "slack_user_token", "--ttl", "1h"], 10_000);
    const token = result.stdout.trim();
    if (!token) throw new Error("empty lease");
    return token;
  } catch (error) {
    throw new Error(
      `Failed to lease slack_user_token: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const permanentSlackErrors = new Set([
  "invalid_auth",
  "account_inactive",
  "not_authed",
  "missing_scope",
  "channel_not_found",
  "is_archived",
]);

async function slackGet<T extends { ok: boolean; error?: string }>(
  endpoint: string,
  token: string,
  params: Record<string, string>,
): Promise<T> {
  const query = new URLSearchParams(params);
  const response = await fetch(`https://slack.com/api/${endpoint}?${query.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 429) {
    const retryAfterSeconds = Math.max(
      1,
      Number.parseInt(response.headers.get("retry-after") ?? "30", 10) || 30,
    );
    throw new RetryAfterError(
      `Slack ${endpoint} rate limited for ${retryAfterSeconds}s`,
      `${retryAfterSeconds}s`,
    );
  }
  if (!response.ok) throw new Error(`Slack ${endpoint} failed with HTTP ${response.status}`);
  const payload = (await response.json()) as T;
  if (!payload.ok) {
    const message = `Slack ${endpoint} failed: ${payload.error ?? "unknown_error"}`;
    if (permanentSlackErrors.has(payload.error ?? "")) throw new NonRetriableError(message);
    throw new Error(message);
  }
  return payload;
}

async function scanLiveChannel(
  channel: WorkStateChannel,
  token: string,
  config: WorkStatePassConfig,
  nowMs: number,
): Promise<ChannelScanResult> {
  const history = await slackGet<SlackHistoryResponse>("conversations.history", token, {
    channel: channel.id,
    limit: String(config.historyLimit),
    include_all_metadata: "true",
  });
  return classifyChannelRoots({
    channel,
    roots: history.messages ?? [],
    nowMs,
    untaggedAfterHours: config.untaggedAfterHours,
    startedStaleAfterDays: config.startedStaleAfterDays,
    historyTruncated: Boolean(history.has_more || history.response_metadata?.next_cursor?.trim()),
  });
}

async function resolveAuthorLabels(
  findings: WorkStateFinding[],
  token: string,
): Promise<WorkStateFinding[]> {
  const labels = new Map<string, string | null>();
  for (const authorId of new Set(findings.map((finding) => finding.authorId))) {
    try {
      const response = await slackGet<SlackUserInfoResponse>("users.info", token, { user: authorId });
      const raw = response.user?.profile?.display_name ||
        response.user?.profile?.real_name ||
        response.user?.real_name ||
        response.user?.name ||
        "";
      labels.set(authorId, safeLabel(raw, 80) || null);
    } catch {
      labels.set(authorId, null);
    }
  }
  return findings.map((finding) => ({
    ...finding,
    authorLabel: labels.get(finding.authorId) ?? null,
  }));
}

export function seededScenarioScan(
  config: WorkStatePassConfig,
  nowMs: number,
): ChannelScanResult {
  const channel = { id: "CSEEDED01", name: "seeded-proof" };
  const untaggedTs = String((nowMs - (config.untaggedAfterHours + 1) * 3_600_000) / 1000);
  const staleTs = String((nowMs - (config.startedStaleAfterDays * 24 + 1) * 3_600_000) / 1000);
  return classifyChannelRoots({
    channel,
    roots: [
      { ts: untaggedTs, user: "USEEDEDUNTAGGED" },
      {
        ts: staleTs,
        user: "USEEDEDSTARTED",
        reactions: [{ name: STARTED_REACTION, count: 1, users: [JOEL_SLACK_USER_ID] }],
      },
    ],
    nowMs,
    untaggedAfterHours: config.untaggedAfterHours,
    startedStaleAfterDays: config.startedStaleAfterDays,
    provenance: "seeded-proof",
  });
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function secretScan(text: string): string[] {
  const patterns: Array<[string, RegExp]> = [
    ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/u],
    ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/u],
    ["credential-assignment", /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?[A-Za-z0-9_+\/=.-]{12,}/iu],
  ];
  return patterns.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

export function renderObservationPage(params: {
  runId: string;
  startedAt: string;
  completedAt: string;
  scans: ChannelScanResult[];
  findings: WorkStateFinding[];
  config: WorkStatePassConfig;
  seededScenario: boolean;
}): string {
  const promptHash = createHash("sha256")
    .update(JSON.stringify({
      runId: params.runId,
      channels: params.scans.map((scan) => scan.channel.id),
      findings: params.findings.map((finding) => finding.key),
      thresholds: [params.config.untaggedAfterHours, params.config.startedStaleAfterDays],
    }))
    .digest("hex");
  const observations = params.findings.map((finding) => {
    const author = finding.authorLabel
      ? `${finding.authorLabel} (${finding.authorId})`
      : finding.authorId;
    return [
      `- **${finding.kind === "untagged" ? "Untagged request" : "Stale started request"}** in #${safeLabel(finding.channelName, 80)}`,
      `  - Root: [${finding.rootTs}](${finding.permalink})`,
      `  - Author: ${safeLabel(author, 120)}`,
      `  - Work-state: \`${finding.workState}\``,
      `  - Age: ${finding.ageHours.toFixed(2)} hours; threshold crossed: > ${finding.thresholdHours} hours`,
      `  - Provenance: \`${finding.provenance}\`, channel \`${finding.channelId}\`, root \`${finding.rootTs}\``,
    ].join("\n");
  });
  return `---
type: observation
schemaVersion: 1
title: ${yamlString(`Slack work-state pass ${params.completedAt}`)}
slug: ${yamlString(`${params.completedAt.slice(0, 10)}-slack-work-state-pass-${safeId(params.runId)}`)}
privacy: sensitive
sensitiveReason: ${yamlString("Third-party Slack identity and work-request metadata")}
sourceKind: slack-work-state-pass
identityKind: work-state-pass
producerRunId: ${yamlString(params.runId)}
machine: ${yamlString(hostname().split(".")[0] ?? hostname())}
started: ${yamlString(params.startedAt)}
ended: ${yamlString(params.completedAt)}
seededScenario: ${params.seededScenario}
channels:
${params.scans.map((scan) => `  - ${yamlString(scan.channel.id)}`).join("\n")}
derivation:
  kind: deterministic
  model: deterministic/work-state-pass-v1
  promptHash: ${promptHash}
---

This page records Slack root-message threshold crossings. It does not copy message bodies. Slack reactions remain the work-state source of truth.

## Observations

${observations.join("\n\n")}

## Decisions

- No decision was made by this pass. \`:shitrat:\` and \`:white_check_mark:\` reactions on each Slack root remain canonical.
- The local notified-state file suppresses repeat wakes only; it is not work-state truth.

## Open questions / next actions

- Review the linked Slack roots with full context before acting.
`;
}

async function writeObservationPage(params: {
  runId: string;
  startedAt: string;
  completedAt: string;
  scans: ChannelScanResult[];
  findings: WorkStateFinding[];
  config: WorkStatePassConfig;
  seededScenario: boolean;
}): Promise<string> {
  const page = renderObservationPage(params);
  const secretHits = secretScan(page);
  if (secretHits.length > 0) {
    throw new NonRetriableError(`Observation page blocked by secret scan: ${secretHits.join(", ")}`);
  }
  const filename = `${params.completedAt.slice(0, 10)}-slack-work-state-pass-${safeId(params.runId)}.svx`;
  const path = join(params.config.observationsDir, filename);
  atomicWrite(path, page);
  return path;
}

function emptyState(): NotifiedState {
  return { version: 1, updatedAt: new Date(0).toISOString(), runId: "none", notified: {} };
}

function readNotifiedState(path: string): NotifiedState {
  if (!existsSync(path)) return emptyState();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<NotifiedState>;
    if (parsed.version !== 1 || !parsed.notified || typeof parsed.notified !== "object") return emptyState();
    const runId = typeof parsed.runId === "string" ? parsed.runId : "legacy";
    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
      runId,
      notified: Object.fromEntries(
        Object.entries(parsed.notified).flatMap(([key, value]) => {
          if (!value || typeof value !== "object") return [];
          const entry = value as Partial<NotifiedState["notified"][string]>;
          if (!entry.notifiedAt || !entry.kind || !entry.workState) return [];
          return [[key, {
            notifiedAt: entry.notifiedAt,
            kind: entry.kind,
            workState: entry.workState,
            status: entry.status === "reserved" ? "reserved" : "notified",
            runId: typeof entry.runId === "string" ? entry.runId : runId,
            ...(typeof entry.deliveryEventId === "string"
              ? { deliveryEventId: entry.deliveryEventId }
              : {}),
          }]];
        }),
      ),
    };
  } catch {
    return emptyState();
  }
}

export function selectNewFindings(
  findings: WorkStateFinding[],
  state: NotifiedState,
  nowMs = Date.now(),
): WorkStateFinding[] {
  return findings.filter((finding) => {
    const entry = state.notified[finding.key];
    if (!entry) return true;
    if (entry.status !== "reserved") return false;
    const reservedAt = Date.parse(entry.notifiedAt);
    return !Number.isFinite(reservedAt) || nowMs - reservedAt >= RESERVED_WAKE_TTL_MS;
  });
}

async function reconcileDeliveredReservations(
  state: NotifiedState,
  nowMs: number,
  wasQueued: (eventId: string) => Promise<boolean>,
): Promise<{ state: NotifiedState; reconciled: number }> {
  const staleDeliveryIds = new Set(
    Object.values(state.notified).flatMap((entry) => {
      if (entry.status !== "reserved" || !entry.deliveryEventId) return [];
      const reservedAt = Date.parse(entry.notifiedAt);
      if (Number.isFinite(reservedAt) && nowMs - reservedAt < RESERVED_WAKE_TTL_MS) return [];
      return [entry.deliveryEventId];
    }),
  );
  const delivered = new Set<string>();
  for (const eventId of staleDeliveryIds) {
    if (await wasQueued(eventId)) delivered.add(eventId);
  }
  if (delivered.size === 0) return { state, reconciled: 0 };
  let reconciled = 0;
  const notified = Object.fromEntries(
    Object.entries(state.notified).map(([key, entry]) => {
      if (
        entry.status === "reserved" &&
        entry.deliveryEventId &&
        delivered.has(entry.deliveryEventId)
      ) {
        reconciled += 1;
        return [key, { ...entry, status: "notified" as const }];
      }
      return [key, entry];
    }),
  );
  return { state: { ...state, notified }, reconciled };
}

async function notificationWasQueued(eventId: string): Promise<boolean> {
  return (await getRedisClient().exists(`joelclaw:notify:idempotency:${eventId}`)) === 1;
}

function nextNotifiedState(params: {
  previous: NotifiedState;
  currentFindings: WorkStateFinding[];
  newEntries: WorkStateFinding[];
  newStatus: "reserved" | "notified";
  newDeliveryEventId?: string;
  runId: string;
  nowIso: string;
}): NotifiedState {
  const newEntries = new Set(params.newEntries.map((finding) => finding.key));
  const notified: NotifiedState["notified"] = {};
  for (const finding of params.currentFindings) {
    const prior = params.previous.notified[finding.key];
    if (newEntries.has(finding.key)) {
      notified[finding.key] = {
        notifiedAt: params.nowIso,
        kind: finding.kind,
        workState: finding.workState,
        status: params.newStatus,
        runId: params.runId,
        ...(params.newDeliveryEventId
          ? { deliveryEventId: params.newDeliveryEventId }
          : {}),
      };
    } else if (prior) notified[finding.key] = prior;
  }
  return { version: 1, updatedAt: params.nowIso, runId: params.runId, notified };
}

async function sendWake(params: {
  runId: string;
  eventId: string;
  pagePath: string;
  newFindings: WorkStateFinding[];
  totalFindings: number;
  seededScenario: boolean;
}): Promise<void> {
  const eventId = params.eventId;
  const preview = params.newFindings
    .slice(0, 5)
    .map((finding) => `#${finding.channelName} ${finding.kind}: ${finding.permalink}`)
    .join("\n");
  const more = Math.max(0, params.newFindings.length - 5);
  const message = [
    `${params.seededScenario ? "[seeded proof] " : ""}Slack work-state pass found ${params.newFindings.length} new threshold crossing${params.newFindings.length === 1 ? "" : "s"} (${params.totalFindings} active).`,
    preview,
    more > 0 ? `…and ${more} more in the observation page.` : "",
    `Observation: ${params.pagePath}`,
    "Recall/full context before acting; this wake carries pointers only.",
  ].filter(Boolean).join("\n");
  await runCommand(
    "joelclaw",
    [
      "notify",
      "send",
      message,
      "--priority",
      "normal",
      "--source",
      COMPONENT,
      "--type",
      "slack.work_state.findings",
      "--event-id",
      eventId,
      "--context",
      JSON.stringify({
        runId: params.runId,
        deliveryEventId: eventId,
        pagePath: params.pagePath,
        newFindings: params.newFindings.length,
        totalFindings: params.totalFindings,
        seededScenario: params.seededScenario,
      }),
    ],
    30_000,
  );
}

async function emitStage(params: {
  action: string;
  runId: string;
  success?: boolean;
  level?: "info" | "warn" | "error";
  error?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await emitOtelEvent({
    level: params.level ?? (params.success === false ? "error" : "info"),
    source: "worker",
    component: COMPONENT,
    action: params.action,
    success: params.success ?? true,
    ...(params.error ? { error: params.error } : {}),
    metadata: { runId: params.runId, ...(params.metadata ?? {}) },
  });
}

function countFindingKinds(findings: WorkStateFinding[]): Record<FindingKind, number> {
  return {
    untagged: findings.filter((finding) => finding.kind === "untagged").length,
    stale_started: findings.filter((finding) => finding.kind === "stale_started").length,
  };
}

export const workStatePass = inngest.createFunction(
  {
    id: "slack-work-state-pass",
    name: "Slack: Work-State Pass",
    concurrency: { limit: 1 },
    singleton: { key: '"global"', mode: "skip" },
    retries: 3,
    onFailure: async ({ event, error, step }) => {
      await step.run("record-work-state-pass-failure", async () => {
        const original = event.data.event as {
          id?: string;
          name?: string;
          ts?: number;
          data?: { seededScenario?: boolean };
        };
        const completedAt = new Date().toISOString();
        const runId = safeId(original.id ?? `${original.name ?? "unknown"}-${String(original.ts ?? event.ts)}`);
        const message = error instanceof Error ? error.message : String(error);
        const failed: WorkStatePassLastRun = {
          version: 1,
          status: "failed",
          runId,
          trigger: original.name ?? "unknown",
          startedAt: typeof original.ts === "number" ? new Date(original.ts).toISOString() : completedAt,
          completedAt,
          enabled: process.env.WORK_STATE_PASS_ENABLED === "1",
          seededScenario: original.data?.seededScenario === true,
          channelsScanned: 0,
          channelIds: [],
          rootsSeen: 0,
          requestRootsSeen: 0,
          findings: 0,
          findingKinds: { untagged: 0, stale_started: 0 },
          pages: 0,
          pagePath: null,
          newFindings: 0,
          wakes: 0,
          historyTruncatedChannels: [],
          error: message,
        };
        const lastRunPath = expandHome(
          process.env.WORK_STATE_PASS_LAST_RUN_PATH ?? "~/.joelclaw/work-state-pass-last-run.json",
        );
        atomicWrite(lastRunPath, `${JSON.stringify(failed, null, 2)}\n`);
        await emitStage({
          action: "slack.work_state.pass.failed",
          runId,
          success: false,
          error: message,
          metadata: { trigger: failed.trigger, seededScenario: failed.seededScenario },
        });
      });
    },
  },
  [{ cron: WORK_STATE_PASS_CRON }, { event: "slack/work-state.pass.requested" }],
  async ({ event, step }) => {
    const runId = safeId(event.id ?? `${event.name}-${String(event.ts ?? "unknown")}`);
    const trigger = event.name;
    const seededScenario = event.name === "slack/work-state.pass.requested" && event.data.seededScenario === true;

    const config = await step.run("resolve-work-state-pass-config", async () => {
      const resolved = resolveWorkStatePassConfig();
      if (seededScenario && !resolved.seededProofEnabled) {
        throw new NonRetriableError(
          "Seeded proof requested while WORK_STATE_PASS_SEEDED_PROOF_ENABLED is false",
        );
      }
      await emitStage({
        action: "slack.work_state.pass.configured",
        runId,
        metadata: {
          enabled: resolved.enabled,
          trigger,
          seededScenario,
          channelIds: resolved.channels.map((channel) => channel.id),
          untaggedAfterHours: resolved.untaggedAfterHours,
          startedStaleAfterDays: resolved.startedStaleAfterDays,
          historyLimit: resolved.historyLimit,
          wakeMode: resolved.wakeMode,
        },
      });
      return resolved;
    });

    const startedAt = await step.run("start-work-state-pass", async () => {
      const value = new Date().toISOString();
      await emitStage({
        action: "slack.work_state.pass.started",
        runId,
        metadata: { trigger, seededScenario, enabled: config.enabled },
      });
      return value;
    });

    if (!config.enabled) {
      return step.run("record-disabled-pass", async () => {
        const skipped: WorkStatePassLastRun = {
          version: 1,
          status: "skipped",
          runId,
          trigger,
          startedAt,
          completedAt: new Date().toISOString(),
          enabled: false,
          seededScenario,
          channelsScanned: 0,
          channelIds: [],
          rootsSeen: 0,
          requestRootsSeen: 0,
          findings: 0,
          findingKinds: { untagged: 0, stale_started: 0 },
          pages: 0,
          pagePath: null,
          newFindings: 0,
          wakes: 0,
          historyTruncatedChannels: [],
        };
        atomicWrite(config.lastRunPath, `${JSON.stringify(skipped, null, 2)}\n`);
        await emitStage({
          action: "slack.work_state.pass.skipped",
          runId,
          level: "warn",
          metadata: { reason: "disabled", trigger },
        });
        return skipped;
      });
    }

    const nowMs = await step.run("capture-work-state-pass-clock", () => Date.now());
    const scans: ChannelScanResult[] = [];
    for (const channel of config.channels) {
      const scan = await step.run(`scan-slack-channel-${channel.id}`, async () => {
        try {
          const token = await leaseSlackUserToken();
          const result = await scanLiveChannel(channel, token, config, nowMs);
          await emitStage({
            action: "slack.work_state.pass.channel_scanned",
            runId,
            metadata: {
              channelId: channel.id,
              channelName: channel.name,
              rootsSeen: result.rootsSeen,
              requestRootsSeen: result.requestRootsSeen,
              findings: result.findings.length,
              historyTruncated: result.historyTruncated,
            },
          });
          return result;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await emitStage({
            action: "slack.work_state.pass.channel_failed",
            runId,
            success: false,
            error: message,
            metadata: { channelId: channel.id, channelName: channel.name },
          });
          throw error;
        }
      });
      scans.push(scan);
    }

    if (seededScenario) {
      const seeded = await step.run("add-seeded-work-state-scenario", async () => {
        const result = seededScenarioScan(config, nowMs);
        await emitStage({
          action: "slack.work_state.pass.seeded",
          runId,
          metadata: {
            rootsSeen: result.rootsSeen,
            findings: result.findings.length,
            kinds: countFindingKinds(result.findings),
          },
        });
        return result;
      });
      scans.push(seeded);
    }

    const unresolvedFindings = scans.flatMap((scan) => scan.findings);
    const findings = unresolvedFindings.length > 0
      ? await step.run("resolve-work-state-authors", async () => {
          const token = await leaseSlackUserToken();
          return resolveAuthorLabels(unresolvedFindings, token);
        })
      : unresolvedFindings;

    const completedAt = await step.run("capture-work-state-pass-completion-time", () =>
      new Date().toISOString(),
    );
    const pagePath = findings.length > 0
      ? await step.run("write-work-state-observation-page", async () => {
          try {
            const path = await writeObservationPage({
              runId,
              startedAt,
              completedAt,
              scans,
              findings,
              config,
              seededScenario,
            });
            await emitStage({
              action: "slack.work_state.pass.page_written",
              runId,
              metadata: { pagePath: path, findings: findings.length },
            });
            return path;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await emitStage({
              action: "slack.work_state.pass.page_failed",
              runId,
              success: false,
              error: message,
              metadata: { findings: findings.length },
            });
            throw error;
          }
        })
      : null;

    const wakeResult = await step.run("dispatch-work-state-wake", async () => {
      const loaded = readNotifiedState(config.notifiedStatePath);
      const reconciliation = await reconcileDeliveredReservations(
        loaded,
        Date.parse(completedAt),
        notificationWasQueued,
      );
      const previous = reconciliation.state;
      if (reconciliation.reconciled > 0) {
        await emitStage({
          action: "slack.work_state.pass.wake_reconciled",
          runId,
          metadata: { reconciled: reconciliation.reconciled },
        });
      }
      const newFindings = selectNewFindings(findings, previous, Date.parse(completedAt));
      let wakes = 0;
      let next = nextNotifiedState({
        previous,
        currentFindings: findings,
        newEntries: [],
        newStatus: "reserved",
        runId,
        nowIso: completedAt,
      });
      if (newFindings.length > 0 && config.wakeMode === "notify") {
        if (!pagePath) throw new Error("Cannot wake without an observation page pointer");
        const eventId = deliveryEventId(newFindings);
        const reserved = nextNotifiedState({
          previous,
          currentFindings: findings,
          newEntries: newFindings,
          newStatus: "reserved",
          newDeliveryEventId: eventId,
          runId,
          nowIso: completedAt,
        });
        // Reserve before the external side effect. A worker crash may defer a wake,
        // but it cannot send the same state transition twice on retry.
        atomicWrite(config.notifiedStatePath, `${JSON.stringify(reserved, null, 2)}\n`);
        try {
          await sendWake({
            runId,
            eventId,
            pagePath,
            newFindings,
            totalFindings: findings.length,
            seededScenario,
          });
        } catch (error) {
          atomicWrite(config.notifiedStatePath, `${JSON.stringify(next, null, 2)}\n`);
          const message = error instanceof Error ? error.message : String(error);
          await emitStage({
            action: "slack.work_state.pass.wake_failed",
            runId,
            success: false,
            error: message,
            metadata: { newFindings: newFindings.length, pagePath },
          });
          throw error;
        }
        next = {
          ...reserved,
          notified: Object.fromEntries(
            Object.entries(reserved.notified).map(([key, entry]) => [
              key,
              entry.runId === runId && entry.status === "reserved"
                ? { ...entry, status: "notified" as const }
                : entry,
            ]),
          ),
        };
        atomicWrite(config.notifiedStatePath, `${JSON.stringify(next, null, 2)}\n`);
        wakes = 1;
        await emitStage({
          action: "slack.work_state.pass.wake_sent",
          runId,
          metadata: {
            newFindings: newFindings.length,
            totalFindings: findings.length,
            pagePath,
            seededScenario,
          },
        });
      } else {
        atomicWrite(config.notifiedStatePath, `${JSON.stringify(next, null, 2)}\n`);
        await emitStage({
          action: "slack.work_state.pass.wake_skipped",
          runId,
          metadata: {
            reason: newFindings.length === 0 ? "no-state-change" : "wake-mode-off",
            newFindings: newFindings.length,
            activeFindings: findings.length,
          },
        });
      }
      return { newFindings: newFindings.length, wakes };
    });

    const report: WorkStatePassLastRun = {
      version: 1,
      status: "completed",
      runId,
      trigger,
      startedAt,
      completedAt,
      enabled: true,
      seededScenario,
      channelsScanned: scans.length,
      channelIds: scans.map((scan) => scan.channel.id),
      rootsSeen: scans.reduce((sum, scan) => sum + scan.rootsSeen, 0),
      requestRootsSeen: scans.reduce((sum, scan) => sum + scan.requestRootsSeen, 0),
      findings: findings.length,
      findingKinds: countFindingKinds(findings),
      pages: pagePath ? 1 : 0,
      pagePath,
      newFindings: wakeResult.newFindings,
      wakes: wakeResult.wakes,
      historyTruncatedChannels: scans
        .filter((scan) => scan.historyTruncated)
        .map((scan) => scan.channel.id),
    };

    await step.run("complete-work-state-pass", async () => {
      atomicWrite(config.lastRunPath, `${JSON.stringify(report, null, 2)}\n`);
      await emitStage({
        action: "slack.work_state.pass.completed",
        runId,
        metadata: report,
      });
    });

    return report;
  },
);

export const __workStatePassTestUtils = {
  JOEL_SLACK_USER_ID,
  STARTED_REACTION,
  SHIPPED_REACTION,
  RESERVED_WAKE_TTL_MS,
  WORK_STATE_PASS_CRON,
  deliveryEventId,
  nextNotifiedState,
  reconcileDeliveredReservations,
  secretScan,
  slackGet,
};
