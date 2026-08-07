import {
  parseGatewayIncidentObservation,
  reconcileGatewayIncident,
  reconstructGatewayIncidentStore,
} from "@joelclaw/gateway-incident-latch";
import {
  createMessageEventLogClient,
  GATEWAY_MESSAGE_EVENT_CONSUMER,
  gatewayDecisionSemanticKey,
} from "@joelclaw/message-event-log";

const MAX_SCAN_EVENTS = 20_000;
const PAGE_SIZE = 500;

/** Joel's real operator actors. Machine producers never use these. */
export const JOEL_ACTOR_IDS = new Set(["7718912466", "U030BJ3CK"]);

/**
 * Hard cap on open+join decisions for one aggregateId. A 518-join health
 * aggregate is a bug, not a busy day — past this the agent must close or drop.
 */
export const MAX_AGGREGATE_JOINS = 25;

const TERMINAL_VERBS = new Set(["deliver", "observe", "fanout", "route", "drop"]);

const REWRITE_LINTS = [
  {
    id: "tool-refusal",
    re: /\b(no live|don'?t have a|do not have a)\b.{0,80}\b(feed|access|tool|data|way)\b|\bpoint me at a tool\b|\bas the comms gateway\b.{0,60}\b(can'?t|cannot)\b|\bI(?:'m| am) the (?:comms )?gateway(?: loop)?\b.{0,120}\b(can'?t|cannot|no live)\b/iu,
    fix: "You have Bash, WebFetch, and WebSearch. Run the command or fetch the page. Never narrate a missing tool.",
  },
  {
    id: "self-intro",
    re: /\bI(?:'m| am) the (?:comms )?gateway(?: loop)?\b|\bgateway loop is alive\b|\bstream is clear\b/iu,
    fix: "You are already in the conversation. Answer the substance. Never introduce yourself or announce that the loop is alive.",
  },
];

function nonEmpty(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive safe integer`);
  return value;
}

export function eventText(event) {
  const payload = event?.payload ?? {};
  const content = payload.content;
  if (typeof payload.text === "string") return payload.text;
  if (typeof content === "string") return content;
  if (content && typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (typeof content.data?.text === "string") return content.data.text;
  }
  if (typeof payload.rewrite === "string") return payload.rewrite;
  if (typeof payload.decision?.rewrite === "string") return payload.decision.rewrite;
  return "";
}

export function isJoelInbound(event) {
  if (!event || event.kind !== "inbound.received") return false;
  const actorId = event.payload?.actorId;
  return typeof actorId === "string" && JOEL_ACTOR_IDS.has(actorId);
}

export function inboundAddressing(event) {
  // Backlog rows from before the transport stamp stay addressed. Failing open
  // here preserves replies; only an explicit ambient stamp suppresses output.
  return event?.payload?.addressing === "ambient" ? "ambient" : "addressed";
}

function isWorkRequest(event) {
  return event?.kind === "inbound.received"
    && event?.payload?.workRequest
    && typeof event.payload.workRequest === "object";
}

function isWorkRequestDeliveryReady(event) {
  if (!isWorkRequest(event)) return false;
  const workRequest = event.payload.workRequest;
  return workRequest.userDeliveryReady === true
    || workRequest.botDeliveryReady === true;
}

function hasWorkRequestBinding(event) {
  if (!isWorkRequest(event)) return false;
  const binding = event.payload.workRequest.binding;
  return binding && typeof binding === "object"
    && [binding.cwd, binding.repo].some((value) =>
      typeof value === "string" && value.trim().length > 0);
}

export function normalizeSlackReplyThreadId(channelId, replyThreadId) {
  if (typeof channelId !== "string" || typeof replyThreadId !== "string") {
    return replyThreadId;
  }
  const timestamp = replyThreadId.split(":").at(-1);
  return /^\d+\.\d+$/u.test(timestamp ?? "")
    ? `slack:${channelId}:${timestamp}`
    : replyThreadId;
}

function slackWorkRequestReturnTarget(event) {
  if (!isWorkRequest(event)) return null;
  const workRequest = event.payload.workRequest;
  if (
    typeof workRequest.channelId !== "string"
    || typeof workRequest.replyThreadId !== "string"
  ) return null;
  return {
    kind: "platform",
    platform: "slack",
    conversationId: workRequest.channelId,
    threadId: normalizeSlackReplyThreadId(
      workRequest.channelId,
      workRequest.replyThreadId,
    ),
  };
}

function isOutboundDecision(decision) {
  return decision?.verb === "deliver"
    || (decision?.verb === "aggregate" && decision?.action === "close-deliver");
}

function slackWorkerReturnTarget(event) {
  if (event?.kind !== "message.requested" || event?.source !== "shitrat-worker") {
    return null;
  }
  const context = event?.payload?.evidence?.context;
  if (
    context?.platform !== "slack"
    || typeof context.channelId !== "string"
    || typeof context.replyThreadId !== "string"
    || typeof context.taskId !== "string"
  ) return null;
  return {
    kind: "platform",
    platform: "slack",
    conversationId: context.channelId,
    threadId: normalizeSlackReplyThreadId(context.channelId, context.replyThreadId),
  };
}

function slackDeliveryForTarget(target) {
  if (!target) return null;
  const messageTs = target.threadId.split(":").at(-1);
  if (!/^\d+\.\d+$/u.test(messageTs ?? "")) return null;
  return {
    identity: "joel",
    channelId: target.conversationId,
    messageTs,
  };
}

function slackWorkerCompletion(event) {
  const target = slackWorkerReturnTarget(event);
  const context = event?.payload?.evidence?.context;
  if (context?.workerPhase === "progress") return null;
  const taskId = context?.taskId;
  const delivery = slackDeliveryForTarget(target);
  if (!delivery || typeof taskId !== "string") return null;
  return {
    channelId: delivery.channelId,
    messageTs: delivery.messageTs,
    reaction: "white_check_mark",
    taskId,
  };
}

export function textFingerprint(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .replace(/[0-9]{1,2}:[0-9]{2}(:[0-9]{2})?/gu, "")
    .replace(/\b20\d{2}-\d{2}-\d{2}\b/gu, "")
    .trim()
    .slice(0, 240);
}

export function lintRewrite(rewrite) {
  if (typeof rewrite !== "string" || rewrite.trim() === "") return null;
  for (const rule of REWRITE_LINTS) {
    if (rule.re.test(rewrite)) {
      return `Rewrite rejected (${rule.id}): ${rule.fix}`;
    }
  }
  return null;
}

function isTerminalDecision(decision) {
  if (!decision || typeof decision !== "object") return false;
  if (TERMINAL_VERBS.has(decision.verb)) return true;
  return decision.verb === "aggregate" && decision.action === "close-deliver";
}

/**
 * Compact one pending event for boot/tool surfaces. Full JSON dumps were
 * 14–49k chars of dead weight; the agent needs id, kind, and a one-line hint.
 */
export function compactPendingEvent(event, { now = Date.now() } = {}) {
  const recordedAt = typeof event?.recordedAt === "number" ? event.recordedAt : now;
  const ageSec = Math.max(0, Math.round((now - recordedAt) / 1000));
  const fullText = eventText(event).replace(/\s+/gu, " ").trim().slice(0, 2_000);
  const text = fullText.slice(0, 80);
  const workRequest = event?.payload?.workRequest;
  const workerContext = event?.payload?.evidence?.context;
  const workerResult = workerContext?.taskId
    ? {
        taskId: workerContext.taskId,
        platform: workerContext.platform ?? null,
        channelId: workerContext.channelId ?? null,
        replyThreadId: workerContext.platform === "slack"
          ? normalizeSlackReplyThreadId(
              workerContext.channelId,
              workerContext.replyThreadId,
            )
          : workerContext.replyThreadId ?? null,
        phase: workerContext.workerPhase === "progress" ? "progress" : "result",
      }
    : null;
  return {
    id: event?._id ?? null,
    kind: event?.kind ?? "unknown",
    source: event?.source ?? null,
    ageSec,
    text,
    joel: isJoelInbound(event),
    ...(isJoelInbound(event) ? { addressing: inboundAddressing(event) } : {}),
    ...(workRequest ? {
      workRequest: {
        channelName: workRequest.channelName,
        text: fullText,
        botDeliveryReady: workRequest.botDeliveryReady === true,
        userDeliveryReady: workRequest.userDeliveryReady === true,
        replyThreadId: normalizeSlackReplyThreadId(
          workRequest.channelId,
          workRequest.replyThreadId,
        ),
        binding: workRequest.binding ?? null,
      },
    } : {}),
    ...(workerResult ? { workerResult } : {}),
  };
}

export function compactPendingList(events, { now = Date.now() } = {}) {
  const rows = (events ?? []).map((event) => compactPendingEvent(event, { now }));
  rows.sort((a, b) => Number(b.joel) - Number(a.joel));
  return rows;
}

export function validateDecisionPayload(payload, { aggregateStats = null } = {}) {
  if (!payload || typeof payload !== "object") throw new Error("payload must be an object");
  if (!Array.isArray(payload.inputEventIds) || payload.inputEventIds.length === 0) {
    throw new Error("inputEventIds must contain at least one event ID");
  }
  const inputEventIds = payload.inputEventIds.map((id, index) => nonEmpty(id, `inputEventIds[${index}]`));
  if (new Set(inputEventIds).size !== inputEventIds.length) throw new Error("inputEventIds must not contain duplicates");
  nonEmpty(payload.reason, "reason");
  nonEmpty(payload.promptRevision, "promptRevision");
  positiveInteger(payload.decisionSeq, "decisionSeq");
  const decision = payload.decision;
  if (!decision || typeof decision !== "object") throw new Error("decision must be an object");
  const verbs = new Set(["deliver", "aggregate", "escalate", "observe", "fanout", "route", "drop"]);
  if (!verbs.has(decision.verb)) throw new Error(`Unsupported decision verb: ${decision.verb}`);

  // A decision that delivers must carry the full operator-facing message.
  // Five close-delivers shipped without text on cutover day and were never
  // sent — the executor cannot deliver what was never written.
  const delivers = decision.verb === "deliver"
    || decision.action === "close-deliver"
    || decision.delivery === "immediate";
  if (delivers && (typeof payload.rewrite !== "string" || payload.rewrite.trim().length === 0)) {
    throw new Error("immediate and close-deliver decisions require non-empty payload.rewrite — the exact message text Joel receives");
  }
  if (delivers) {
    const lintError = lintRewrite(payload.rewrite);
    if (lintError) throw new Error(lintError);
  }

  // A fanout without a taskId cannot be matched to the worker result that comes
  // back, so the work silently detaches from its receipt. Nine of the first
  // twenty-four fanouts had no taskId; one of those workers was never accounted
  // for at all.
  if (decision.verb === "fanout" && (typeof decision.taskId !== "string" || decision.taskId.trim().length === 0)) {
    throw new Error("fanout decisions require decision.taskId — the id the worker returns its result under");
  }

  if (decision.verb === "aggregate") {
    if (!new Set(["open", "join", "extend", "close-deliver"]).has(decision.action)) {
      throw new Error(`Unsupported aggregate action: ${decision.action}`);
    }
    nonEmpty(decision.aggregateId, "decision.aggregateId");
    if (!Array.isArray(decision.memberEventIds) || decision.memberEventIds.length === 0) {
      throw new Error("decision.memberEventIds must not be empty");
    }
    const members = decision.memberEventIds.map((id, index) => nonEmpty(id, `decision.memberEventIds[${index}]`));
    if (new Set(members).size !== members.length) throw new Error("decision.memberEventIds must not contain duplicates");
    for (const inputEventId of inputEventIds) {
      if (!members.includes(inputEventId)) throw new Error(`Aggregate members do not include input ${inputEventId}`);
    }

    // Open/extend without a deadline is how health incidents live forever.
    // wake_schedule_aggregate_deadline is the timer; holdUntil is the receipt.
    if (
      (decision.action === "open" || decision.action === "extend")
      && payload.incident === undefined
    ) {
      const holdUntilMs = Date.parse(String(decision.holdUntil ?? ""));
      const numericHold = typeof decision.holdUntil === "number" ? decision.holdUntil : holdUntilMs;
      if (!Number.isFinite(numericHold) || numericHold <= Date.now()) {
        throw new Error(
          "aggregate open/extend requires decision.holdUntil in the future, then call wake_schedule_aggregate_deadline with the same id — open-ended aggregates never close",
        );
      }
    }

    if (decision.action === "join" && aggregateStats) {
      const priorDecisions = aggregateStats.decisionCount ?? 0;
      if (priorDecisions >= MAX_AGGREGATE_JOINS) {
        throw new Error(
          `aggregate ${decision.aggregateId} already has ${priorDecisions} open/join decisions (cap ${MAX_AGGREGATE_JOINS}). Close-deliver or drop — a giant join pile is a bug`,
        );
      }
      if (aggregateStats.duplicateTick) {
        throw new Error(
          `aggregate ${decision.aggregateId}: identical repeated tick after the incident is known — drop it, do not join forever`,
        );
      }
    }
  }

  return { ...payload, inputEventIds, reason: payload.reason.trim(), promptRevision: payload.promptRevision.trim() };
}

/**
 * Default advanceAfter for single-input terminal decisions.
 * Acks must pass advanceAfter: false explicitly so the cursor stays for the
 * result decision on the same Joel input. Everything else advances in one call.
 */
export function resolveAdvanceAfter(payload, advanceAfter) {
  if (typeof advanceAfter === "boolean") return advanceAfter;
  if (!payload || payload.inputEventIds?.length !== 1) return false;
  if (payload.incident) return true;
  if (!isTerminalDecision(payload.decision)) return false;
  return true;
}

export function createStreamTools({ client = createMessageEventLogClient(), now = () => Date.now() } = {}) {
  async function scanAll({ recordedAt = 0, stopWhen } = {}) {
    const events = [];
    let cursor = null;
    do {
      const page = await client.readSince(recordedAt, PAGE_SIZE, cursor);
      for (const event of page.events) {
        events.push(event);
        if (stopWhen?.(event)) return events;
        if (events.length >= MAX_SCAN_EVENTS) throw new Error(`Stream scan exceeded ${MAX_SCAN_EVENTS} events`);
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
    return events;
  }

  async function appendAndReadBack(input) {
    const before = now();
    const receipt = await client.append(input);
    const candidates = await scanAll({ recordedAt: Math.max(0, before - 5_000), stopWhen: (event) => event._id === receipt.eventId });
    const event = candidates.find((candidate) => candidate._id === receipt.eventId);
    if (!event) throw new Error(`Append readback failed for ${receipt.eventId}`);
    if (event.kind !== input.kind || event.semanticKey !== input.semanticKey) {
      throw new Error(`Append readback mismatch for ${receipt.eventId}`);
    }
    return { receipt, event };
  }

  async function loadPending(limit = 200) {
    return client.pendingForConsumer(GATEWAY_MESSAGE_EVENT_CONSUMER, limit);
  }

  function decisionsCovering(events, eventId) {
    return events.filter(
      (event) => event.kind === "gateway.decision.recorded" && event.payload?.inputEventIds?.includes(eventId),
    );
  }

  function hasDeliverCovering(events, eventId) {
    return decisionsCovering(events, eventId).some((event) =>
      isOutboundDecision(event.payload?.decision));
  }

  function hasFanoutCovering(events, eventId) {
    return decisionsCovering(events, eventId).some((event) =>
      event.payload?.decision?.verb === "fanout");
  }

  function hasEscalationCovering(events, eventId) {
    return decisionsCovering(events, eventId).some((event) =>
      event.payload?.decision?.verb === "escalate");
  }

  /**
   * Addressed Joel inbounds still pending with zero deliver receipt. Ambient
   * inbounds require observe or escalation, never an automatic ack.
   */
  async function unackedJoelInbound({ pending: pendingArg, events: eventsArg } = {}) {
    const pending = pendingArg ?? await loadPending(200);
    const joelPending = pending.filter((event) =>
      isJoelInbound(event)
      && inboundAddressing(event) === "addressed"
      && !isWorkRequest(event));
    if (joelPending.length === 0) return [];
    const events = eventsArg ?? await scanAll();
    return joelPending.filter((event) => !hasDeliverCovering(events, event._id));
  }

  async function assertJoelAckPriority({ toolName, coveringIds = [], toolArgs = {} } = {}) {
    const pending = await loadPending(200);
    const blocked = await unackedJoelInbound({ pending });
    const still = blocked.filter((event) => !coveringIds.includes(event._id));
    if (still.length > 0) {
      const ids = still.map((event) => event._id).join(", ");
      throw new Error(
        `Ack Joel first before ${toolName}. Unacked Joel inbound: ${ids}. `
        + "First tool call must be stream_record_decision deliver decisionSeq:1 rewrite \"on it — …\" with advanceAfter: false. "
        + "One-shot short answers may omit advanceAfter (defaults true) or set it true.",
      );
    }

    const identityBlocked = pending.filter((event) =>
      isWorkRequest(event)
      && !isWorkRequestDeliveryReady(event)
      && !coveringIds.includes(event._id));
    if (identityBlocked.length > 0) {
      const ids = identityBlocked.map((event) => event._id).join(", ");
      throw new Error(
        `Joel's Slack token must reach the channel before ${toolName}: ${ids}. `
        + "Record one advancing drop decision; the request failed closed because personal-token delivery is unavailable.",
      );
    }

    const boundWorkRequests = pending.filter((event) =>
      isWorkRequest(event)
      && isWorkRequestDeliveryReady(event)
      && hasWorkRequestBinding(event)
      && !coveringIds.includes(event._id));
    if (boundWorkRequests.length > 0) {
      const ids = boundWorkRequests.map((event) => event._id).join(", ");
      if (toolName !== "herdr_dispatch_worker") {
        throw new Error(
          `Bound Slack workRequest must use shitrat_triage, then either reply-and-stop or herdr_dispatch_worker before ${toolName}: ${ids}. `
          + "Generic herdr_prompt reuse is forbidden.",
        );
      }
      const sourceEventId = toolArgs?.resultContext?.sourceEventId;
      const matched = boundWorkRequests.find((event) => event._id === sourceEventId);
      const workRequest = matched?.payload?.workRequest;
      const expectedCwd = workRequest?.binding?.cwd?.trim()
        || workRequest?.binding?.repo?.trim();
      const expectedThreadId = workRequest
        ? normalizeSlackReplyThreadId(
            workRequest.channelId,
            workRequest.replyThreadId,
          )
        : undefined;
      const actualThreadId = normalizeSlackReplyThreadId(
        toolArgs?.resultContext?.channelId,
        toolArgs?.resultContext?.replyThreadId,
      );
      if (
        !matched
        || toolArgs?.resultContext?.platform !== "slack"
        || toolArgs?.freshWorkspace !== true
        || toolArgs?.worktree !== true
        || toolArgs?.cwd !== expectedCwd
        || toolArgs?.resultContext?.channelId !== workRequest.channelId
        || actualThreadId !== expectedThreadId
      ) {
        throw new Error(
          `Slack dispatch must match pending workRequest ${ids}: sourceEventId, channelId, `
          + "normalized replyThreadId, binding cwd, resultContext.platform=slack, "
          + "freshWorkspace:true, and worktree:true",
        );
      }
    }

    const missingBindings = pending.filter((event) =>
      isWorkRequest(event)
      && isWorkRequestDeliveryReady(event)
      && !hasWorkRequestBinding(event)
      && !coveringIds.includes(event._id));
    if (missingBindings.length > 0) {
      const ids = missingBindings.map((event) => event._id).join(", ");
      throw new Error(
        `Triage unbound Slack workRequest before ${toolName}: ${ids}. `
        + "Do not launch a worker. Social/answer activations reply and stop; real work replies with the missing project mapping.",
      );
    }
  }

  async function aggregateJoinStats(decision, inputEventIds) {
    if (decision.verb !== "aggregate" || decision.action !== "join") return null;
    const events = await scanAll();
    const related = events.filter((event) => {
      if (event.kind !== "gateway.decision.recorded") return false;
      const d = event.payload?.decision;
      return d?.verb === "aggregate" && d?.aggregateId === decision.aggregateId
        && (d.action === "open" || d.action === "join" || d.action === "extend");
    });
    const decisionCount = related.length;
    const knownFingerprints = new Set();
    for (const event of related) {
      for (const memberId of event.payload?.decision?.memberEventIds ?? []) {
        const member = events.find((candidate) => candidate._id === memberId);
        if (!member) continue;
        knownFingerprints.add(`${member.source ?? ""}|${textFingerprint(eventText(member))}`);
      }
    }
    let duplicateTick = false;
    if (decisionCount >= 1) {
      for (const inputEventId of inputEventIds) {
        const input = events.find((candidate) => candidate._id === inputEventId)
          ?? (await loadPending(200)).find((candidate) => candidate._id === inputEventId);
        if (!input) continue;
        const fp = `${input.source ?? ""}|${textFingerprint(eventText(input))}`;
        if (knownFingerprints.has(fp) && textFingerprint(eventText(input)).length >= 24) {
          duplicateTick = true;
          break;
        }
      }
    }
    return { decisionCount, duplicateTick };
  }

  return {
    readSince: (args) => client.readSince(args.recordedAt, args.limit ?? 100, args.cursor ?? null),
    pending: async (args = {}) => {
      const pending = await loadPending(args.limit ?? 100);
      const events = await scanAll();
      const needsAck = await unackedJoelInbound({ pending, events });
      const compact = compactPendingList(pending, { now: now() });
      return {
        consumer: GATEWAY_MESSAGE_EVENT_CONSUMER,
        ackRequiredJoel: needsAck.map((event) => ({
          id: event._id,
          text: eventText(event).replace(/\s+/gu, " ").trim().slice(0, 120),
        })),
        instruction: needsAck.length > 0
          ? "JOEL ACK REQUIRED: first tool call is stream_record_decision deliver decisionSeq:1 with a short \"on it — …\" rewrite. Do not call stream_pending again first."
          : null,
        pending: compact,
      };
    },
    bootstrap: async (args = {}) => {
      const pending = await loadPending(args.limit ?? 200);
      const all = await scanAll();
      const latestHandoff = all.filter((event) => event.kind === "gateway.handoff").at(-1) ?? null;
      const needsAck = await unackedJoelInbound({ pending, events: all });
      return {
        consumer: GATEWAY_MESSAGE_EVENT_CONSUMER,
        latestHandoff,
        pending: pending.map((event) => {
          if (!isWorkRequest(event)) return event;
          const workRequest = event.payload.workRequest;
          return {
            ...event,
            payload: {
              ...event.payload,
              workRequest: {
                ...workRequest,
                replyThreadId: normalizeSlackReplyThreadId(
                  workRequest.channelId,
                  workRequest.replyThreadId,
                ),
              },
            },
          };
        }),
        pendingCompact: compactPendingList(pending, { now: now() }),
        ackRequiredJoel: needsAck.map((event) => event._id),
        replayAuthoritative: true,
      };
    },
    unackedJoelInbound: () => unackedJoelInbound(),
    assertJoelAckPriority: (args) => assertJoelAckPriority(args),
    recordDecision: async ({ payload, flowId, origin, advanceAfter }) => {
      const inputEventIds = Array.isArray(payload?.inputEventIds) ? payload.inputEventIds : [];
      const events = await scanAll();
      const pending = await loadPending(200);
      const needsAck = await unackedJoelInbound({ pending, events });

      // Machine decisions may not cut in front of an unacked Joel inbound.
      if (needsAck.length > 0) {
        const coversJoel = needsAck.some((event) => inputEventIds.includes(event._id));
        if (!coversJoel) {
          await assertJoelAckPriority({ toolName: "stream_record_decision", coveringIds: inputEventIds });
        }
      }

      // Delivery-ready Slack work requests first deliver Luna's triage reply.
      // Social/answer replies advance and stop. Real work holds the cursor,
      // dispatches once, then advances with one fanout receipt. Missing
      // personal-token access fails closed with one drop. Ordinary addressed
      // inbounds keep the ack-first contract; ambient inbounds require observe
      // or escalation before outbound.
      for (const eventId of inputEventIds) {
        const input = events.find((event) => event._id === eventId)
          ?? pending.find((event) => event._id === eventId);
        if (!input) continue;
        const priorDecisions = decisionsCovering(events, eventId);
        const decision = payload?.decision;
        const verb = decision?.verb;
        const workerReturnTarget = slackWorkerReturnTarget(input);
        if (workerReturnTarget) {
          if (inputEventIds.length !== 1) {
            throw new Error(`Slack worker receipt ${eventId} must be decided alone`);
          }
          if (priorDecisions.length > 0) {
            throw new Error(`Slack worker receipt ${eventId} already has its one canonical decision`);
          }
          if (verb !== "deliver") {
            const phase = input?.payload?.evidence?.context?.workerPhase === "progress"
              ? "progress"
              : "result";
            throw new Error(
              `Slack worker ${phase} ${eventId} must deliver to its bound source thread. Got verb=${verb}`,
            );
          }
          continue;
        }
        if (isWorkRequest(input)) {
          if (inputEventIds.length !== 1) {
            throw new Error(`workRequest ${eventId} must be decided alone`);
          }
          const deliveryReady = isWorkRequestDeliveryReady(input);
          if (!deliveryReady) {
            if (priorDecisions.length > 0) {
              throw new Error(`delivery-blocked workRequest ${eventId} already has its terminal decision`);
            }
            if (verb !== "drop") {
              throw new Error(
                `workRequest ${eventId} must fail closed with one drop because Joel's Slack token cannot deliver in that channel. Got verb=${verb}`,
              );
            }
            continue;
          }

          if (priorDecisions.length === 0) {
            if (verb !== "deliver") {
              throw new Error(
                `workRequest ${eventId} must first deliver the Luna triage reply to its Slack thread. Got verb=${verb}`,
              );
            }
            if (!slackWorkRequestReturnTarget(input)) {
              throw new Error(`workRequest ${eventId} is missing its Slack return thread`);
            }
            continue;
          }

          if (!hasWorkRequestBinding(input)) {
            throw new Error(`unbound workRequest ${eventId} already has its terminal triage reply`);
          }
          if (hasFanoutCovering(events, eventId)) {
            throw new Error(`Bound workRequest ${eventId} already has its fanout decision`);
          }
          if (!hasDeliverCovering(events, eventId) || verb !== "fanout") {
            throw new Error(
              `Bound workRequest ${eventId} may fan out only after its Luna triage reply. Got verb=${verb}`,
            );
          }
          continue;
        }
        if (!isJoelInbound(input)) continue;
        if (inboundAddressing(input) === "ambient") {
          if (isOutboundDecision(decision) && !hasEscalationCovering(events, eventId)) {
            throw new Error(
              `Ambient inbound ${eventId} cannot produce outbound. First record an escalate decision for the same inputEventId with a reason explaining why it became addressed; then record the deliver decision. Otherwise record an observe decision.`,
            );
          }
          if (priorDecisions.length === 0 && verb !== "observe" && verb !== "escalate") {
            throw new Error(
              `First decision on ambient inbound ${eventId} must be observe or escalate. Got verb=${verb}`,
            );
          }
          continue;
        }
        if (hasDeliverCovering(events, eventId)) continue;
        if (verb !== "deliver") {
          throw new Error(
            `First decision on addressed Joel inbound ${eventId} must be deliver (ack decisionSeq:1, or one-shot answer with advanceAfter). Got verb=${verb}`,
          );
        }
      }

      const coveredInputs = inputEventIds
        .map((eventId) => events.find((event) => event._id === eventId)
          ?? pending.find((event) => event._id === eventId))
        .filter(Boolean);
      const incidentInputs = coveredInputs
        .map((event) => ({
          event,
          observation: parseGatewayIncidentObservation(event),
        }))
        .filter((item) => item.observation !== null);
      if (incidentInputs.length > 0 && coveredInputs.length !== 1) {
        throw new Error(
          "Incident-tagged producer inputs must be decided one at a time so each (source, anomalyId) transition gets one canonical receipt.",
        );
      }
      let candidatePayload = payload;
      const slackReturnTargets = coveredInputs
        .map((event) => slackWorkerReturnTarget(event)
          ?? slackWorkRequestReturnTarget(event))
        .filter(Boolean);
      if (slackReturnTargets.length > 0 && isOutboundDecision(candidatePayload?.decision)) {
        const uniqueTargets = new Set(slackReturnTargets.map((target) => JSON.stringify(target)));
        if (uniqueTargets.size !== 1) {
          throw new Error("One decision cannot deliver worker results to multiple Slack threads");
        }
        const completions = coveredInputs
          .map(slackWorkerCompletion)
          .filter(Boolean);
        const uniqueCompletions = new Set(
          completions.map((completion) => JSON.stringify(completion)),
        );
        if (uniqueCompletions.size > 1) {
          throw new Error("One decision cannot complete multiple Slack work requests");
        }
        const slackDelivery = slackDeliveryForTarget(slackReturnTargets[0]);
        if (!slackDelivery) {
          throw new Error("Slack work delivery target has no valid root timestamp");
        }
        candidatePayload = {
          ...candidatePayload,
          slackDelivery,
          ...(completions[0] ? { slackWorkCompletion: completions[0] } : {}),
          decision: {
            ...candidatePayload.decision,
            target: slackReturnTargets[0],
          },
        };
        const progressOnly = coveredInputs.every(
          (event) => event?.payload?.evidence?.context?.workerPhase === "progress",
        );
        const triageOnly = coveredInputs.every(isWorkRequest);
        const slackRewrite = candidatePayload.rewrite ?? candidatePayload.decision?.rewrite;
        const slackRewriteLimit = progressOnly || triageOnly ? 320 : 1_200;
        const rewriteKind = progressOnly ? "progress" : triageOnly ? "triage" : "result";
        if (typeof slackRewrite === "string" && slackRewrite.length > slackRewriteLimit) {
          throw new Error(
            `Slack ShitRat ${rewriteKind} rewrite exceeds ${slackRewriteLimit} characters; summarize and link the durable report`,
          );
        }
      }
      if (incidentInputs.length === 1) {
        const incident = reconcileGatewayIncident({
          store: reconstructGatewayIncidentStore(events),
          observation: incidentInputs[0].observation,
          inputEventId: incidentInputs[0].event._id,
        });
        candidatePayload = {
          ...payload,
          reason: incident.reason,
          decision: incident.decision,
          incident: incident.receipt,
        };
      }

      const aggregateStats = candidatePayload?.decision && !candidatePayload?.incident
        ? await aggregateJoinStats(candidatePayload.decision, inputEventIds)
        : null;
      const validated = validateDecisionPayload(candidatePayload, { aggregateStats });
      const resolvedAdvance = resolveAdvanceAfter(validated, advanceAfter);
      if (coveredInputs.some(isWorkRequest) && !resolvedAdvance) {
        const heldForBoundWork = validated.decision?.verb === "deliver"
          && coveredInputs.every((event) =>
            isWorkRequest(event)
            && hasWorkRequestBinding(event)
            && decisionsCovering(events, event._id).length === 0);
        if (!heldForBoundWork) {
          throw new Error(
            "Only the first Luna triage reply for bound work may hold the gateway cursor",
          );
        }
      }
      const inheritedFlowIds = [...new Set(
        coveredInputs
          .map((event) => event.flowId)
          .filter((value) => typeof value === "string" && value.trim().length > 0),
      )];
      const inheritedCorrelations = [...new Set(
        coveredInputs
          .map((event) => {
            if (typeof event.correlationId === "string" && event.correlationId.trim().length > 0) {
              return event.correlationId.trim();
            }
            if (
              typeof event.source === "string"
              && event.source.trim().length > 0
              && typeof event.rawSourceId === "string"
              && event.rawSourceId.trim().length > 0
            ) {
              return `${event.source.trim()}:${event.rawSourceId.trim()}`;
            }
            return undefined;
          })
          .filter(Boolean),
      )];
      const resolvedFlowId = flowId
        ?? (inheritedFlowIds.length === 1 ? inheritedFlowIds[0] : undefined);
      const resolvedCorrelationId = inheritedCorrelations.length === 1
        ? inheritedCorrelations[0]
        : undefined;

      const appended = await appendAndReadBack({
        semanticKey: gatewayDecisionSemanticKey(validated),
        kind: "gateway.decision.recorded",
        source: "joelclaw-gateway",
        payload: validated,
        ...(resolvedFlowId ? { flowId: resolvedFlowId } : {}),
        ...(resolvedCorrelationId ? { correlationId: resolvedCorrelationId } : {}),
        ...(origin ? { origin } : {}),
      });

      // Conversational fast path: decision + cursor advance in one tool call.
      // Default is true for single-input terminal decisions so the agent stops
      // burning a second round-trip on stream_advance_after_decision.
      if (resolvedAdvance) {
        if (validated.inputEventIds.length !== 1) {
          throw new Error("advanceAfter requires exactly one inputEventId");
        }
        const cursor = await client.advanceCursor(
          GATEWAY_MESSAGE_EVENT_CONSUMER,
          validated.inputEventIds[0],
        );
        return { ...appended, cursor, advanceAfter: true };
      }
      return { ...appended, advanceAfter: false };
    },
    appendGatewayEvent: async ({ semanticKey, kind, payload, flowId, origin }) => {
      const allowed = new Set(["gateway.handoff", "aggregate.deadline.reached", "inbound.interpreted"]);
      if (!allowed.has(kind)) throw new Error(`Plugin may not append event kind ${kind}`);
      return appendAndReadBack({
        semanticKey: nonEmpty(semanticKey, "semanticKey"),
        kind,
        source: "joelclaw-gateway",
        payload,
        ...(flowId ? { flowId } : {}),
        ...(origin ? { origin } : {}),
      });
    },
    advanceAfterDecision: async ({ eventId, decisionEventId }) => {
      nonEmpty(eventId, "eventId");
      nonEmpty(decisionEventId, "decisionEventId");
      const events = await scanAll();
      const input = events.find((event) => event._id === eventId);
      if (!input) throw new Error(`Input event not found: ${eventId}`);
      if (input.source === "joelclaw-gateway") {
        throw new Error("Use stream_advance_own_output for gateway-owned events");
      }
      const matching = events.filter(
        (event) => event.kind === "gateway.decision.recorded" && event.payload?.inputEventIds?.includes(eventId),
      );
      if (matching.length !== 1) throw new Error(`Expected exactly one decision receipt for ${eventId}; found ${matching.length}`);
      if (matching[0]._id !== decisionEventId) throw new Error(`Decision receipt mismatch for ${eventId}`);
      return client.advanceCursor(GATEWAY_MESSAGE_EVENT_CONSUMER, eventId);
    },
    advanceOwnOutput: async ({ eventId }) => {
      nonEmpty(eventId, "eventId");
      const events = await scanAll({ stopWhen: (event) => event._id === eventId });
      const event = events.find((candidate) => candidate._id === eventId);
      if (!event) throw new Error(`Event not found: ${eventId}`);
      const gatewayAuthoredKinds = new Set(["gateway.decision.recorded", "gateway.handoff"]);
      const gatewaySources = new Set(["joelclaw-gateway", "gateway"]);
      if (!gatewayAuthoredKinds.has(event.kind) && !gatewaySources.has(event.source)) {
        throw new Error(`${eventId} is not gateway-owned output`);
      }
      return client.advanceCursor(GATEWAY_MESSAGE_EVENT_CONSUMER, eventId);
    },
  };
}
