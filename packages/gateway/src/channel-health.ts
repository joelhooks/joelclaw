export type GatewayChannelId = "telegram" | "discord" | "imessage" | "slack";
export type ChannelHealthStatus = "healthy" | "degraded" | "disabled";
export type ChannelHealthEventKind = "degraded" | "recovered";
export type ChannelHealPolicy = "restart" | "manual" | "none";
export type ChannelHealAttemptStatus = "idle" | "scheduled" | "succeeded" | "failed";

export type ChannelHealthEntryInput = {
  configured: boolean;
  healthy: boolean;
  detail: string;
  muted?: boolean;
  muteReason?: string | null;
  healPolicy?: ChannelHealPolicy;
  healReason?: string | null;
  manualRepairSummary?: string | null;
  manualRepairCommands?: string[];
};

export type ChannelHealthEntry = {
  channel: GatewayChannelId;
  status: ChannelHealthStatus;
  configured: boolean;
  healthy: boolean;
  detail: string;
  muted: boolean;
  muteReason: string | null;
  healPolicy: ChannelHealPolicy;
  healReason: string | null;
  manualRepairSummary: string | null;
  manualRepairCommands: string[];
};

export type ChannelHealthSnapshot = {
  overall: "ok" | "degraded";
  configuredChannels: GatewayChannelId[];
  degradedChannels: GatewayChannelId[];
  mutedChannels: GatewayChannelId[];
  healthyCount: number;
  degradedCount: number;
  entries: Record<GatewayChannelId, ChannelHealthEntry>;
};

export type ChannelHealthEvent = {
  channel: GatewayChannelId;
  kind: ChannelHealthEventKind;
  status: ChannelHealthStatus;
  detail: string;
  muted: boolean;
  muteReason: string | null;
  at: number;
};

export type ChannelHealthChannelState = {
  status: ChannelHealthStatus;
  lastChangedAt: number;
  lastEventAt: number;
  lastRecoveredAt: number;
};

export type ChannelHealthAlertState = {
  channels: Record<GatewayChannelId, ChannelHealthChannelState>;
  lastEvent: ChannelHealthEvent | null;
};

export type ChannelHealthAlertDecision = {
  events: ChannelHealthEvent[];
  nextState: ChannelHealthAlertState;
};

export type ChannelHealChannelState = {
  status: ChannelHealthStatus;
  policy: ChannelHealPolicy;
  policyReason: string | null;
  manualRepairSummary: string | null;
  manualRepairCommands: string[];
  consecutiveDegradedCount: number;
  lastAttemptAt: number;
  lastAttemptStatus: ChannelHealAttemptStatus;
  lastAttemptError: string | null;
  attempts: number;
};

export type ChannelRepairGuidance = {
  policy: ChannelHealPolicy;
  reason: string | null;
  manualRepairSummary: string | null;
  manualRepairCommands: string[];
};

export type ChannelHealState = {
  channels: Record<GatewayChannelId, ChannelHealChannelState>;
};

export type ChannelHealDecision = {
  actions: Array<{
    channel: GatewayChannelId;
    policy: "restart";
    detail: string;
    reason: string | null;
    muted: boolean;
    at: number;
  }>;
  nextState: ChannelHealState;
};

function defaultChannelState(): ChannelHealthChannelState {
  return {
    status: "disabled",
    lastChangedAt: 0,
    lastEventAt: 0,
    lastRecoveredAt: 0,
  };
}

function defaultHealState(): ChannelHealChannelState {
  return {
    status: "disabled",
    policy: "none",
    policyReason: null,
    manualRepairSummary: null,
    manualRepairCommands: [],
    consecutiveDegradedCount: 0,
    lastAttemptAt: 0,
    lastAttemptStatus: "idle",
    lastAttemptError: null,
    attempts: 0,
  };
}

function dedupeCommands(commands: string[]): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const command of commands) {
    const normalized = command.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    values.push(normalized);
  }
  return values;
}

export function applyMutedChannelRepairPolicy(
  guidance: ChannelRepairGuidance,
  input: {
    degraded: boolean;
    muted: boolean;
    muteReason?: string | null;
    manualRepairCommands?: string[];
  },
): ChannelRepairGuidance {
  if (!input.degraded || !input.muted) {
    return guidance;
  }

  const summary = input.muteReason?.trim() || guidance.manualRepairSummary || guidance.reason;

  return {
    policy: "manual",
    reason: summary ?? guidance.reason,
    manualRepairSummary: summary ?? null,
    manualRepairCommands: dedupeCommands([
      ...(input.manualRepairCommands ?? []),
      ...guidance.manualRepairCommands,
    ]),
  };
}

export function getInitialChannelHealthAlertState(): ChannelHealthAlertState {
  return {
    channels: {
      telegram: defaultChannelState(),
      discord: defaultChannelState(),
      imessage: defaultChannelState(),
      slack: defaultChannelState(),
    },
    lastEvent: null,
  };
}

export function getInitialChannelHealState(): ChannelHealState {
  return {
    channels: {
      telegram: defaultHealState(),
      discord: defaultHealState(),
      imessage: defaultHealState(),
      slack: defaultHealState(),
    },
  };
}

function toChannelStatus(input: ChannelHealthEntryInput): ChannelHealthStatus {
  if (!input.configured) return "disabled";
  return input.healthy ? "healthy" : "degraded";
}

export function buildChannelHealthSnapshot(input: {
  entries: Record<GatewayChannelId, ChannelHealthEntryInput>;
}): ChannelHealthSnapshot {
  const configuredChannels: GatewayChannelId[] = [];
  const degradedChannels: GatewayChannelId[] = [];
  const mutedChannels: GatewayChannelId[] = [];
  let healthyCount = 0;

  const entries = Object.fromEntries(
    (Object.entries(input.entries) as Array<[GatewayChannelId, ChannelHealthEntryInput]>).map(([channel, value]) => {
      const status = toChannelStatus(value);
      if (value.configured) configuredChannels.push(channel);
      if (status === "healthy") healthyCount += 1;
      if (status === "degraded") degradedChannels.push(channel);
      if (value.muted) mutedChannels.push(channel);

      return [
        channel,
        {
          channel,
          status,
          configured: value.configured,
          healthy: value.healthy,
          detail: value.detail,
          muted: value.muted === true,
          muteReason: value.muteReason ?? null,
          healPolicy: value.healPolicy ?? "none",
          healReason: value.healReason ?? null,
          manualRepairSummary: value.manualRepairSummary ?? null,
          manualRepairCommands: Array.isArray(value.manualRepairCommands)
            ? value.manualRepairCommands.filter((command): command is string => typeof command === "string" && command.trim().length > 0)
            : [],
        } satisfies ChannelHealthEntry,
      ];
    }),
  ) as Record<GatewayChannelId, ChannelHealthEntry>;

  return {
    overall: degradedChannels.length > 0 ? "degraded" : "ok",
    configuredChannels,
    degradedChannels,
    mutedChannels,
    healthyCount,
    degradedCount: degradedChannels.length,
    entries,
  };
}

export function evaluateChannelHealthAlert(
  snapshot: ChannelHealthSnapshot,
  state: ChannelHealthAlertState,
  nowMs: number,
): ChannelHealthAlertDecision {
  const nextState: ChannelHealthAlertState = {
    channels: {
      telegram: { ...state.channels.telegram },
      discord: { ...state.channels.discord },
      imessage: { ...state.channels.imessage },
      slack: { ...state.channels.slack },
    },
    lastEvent: state.lastEvent,
  };

  const events: ChannelHealthEvent[] = [];

  for (const [channel, entry] of Object.entries(snapshot.entries) as Array<[GatewayChannelId, ChannelHealthEntry]>) {
    const previous = nextState.channels[channel] ?? defaultChannelState();
    const statusChanged = previous.status !== entry.status;

    if (!statusChanged) {
      nextState.channels[channel] = previous;
      continue;
    }

    const nextChannelState: ChannelHealthChannelState = {
      ...previous,
      status: entry.status,
      lastChangedAt: nowMs,
      lastEventAt: previous.lastEventAt,
      lastRecoveredAt: previous.lastRecoveredAt,
    };

    if (entry.status === "degraded") {
      const event: ChannelHealthEvent = {
        channel,
        kind: "degraded",
        status: entry.status,
        detail: entry.detail,
        muted: entry.muted,
        muteReason: entry.muteReason,
        at: nowMs,
      };
      events.push(event);
      nextChannelState.lastEventAt = nowMs;
    } else if (previous.status === "degraded" && entry.status === "healthy") {
      const event: ChannelHealthEvent = {
        channel,
        kind: "recovered",
        status: entry.status,
        detail: entry.detail,
        muted: entry.muted,
        muteReason: entry.muteReason,
        at: nowMs,
      };
      events.push(event);
      nextChannelState.lastRecoveredAt = nowMs;
      nextChannelState.lastEventAt = nowMs;
    }

    nextState.channels[channel] = nextChannelState;
  }

  if (events.length > 0) {
    nextState.lastEvent = events[events.length - 1] ?? state.lastEvent;
  }

  return {
    events,
    nextState,
  };
}

export function evaluateChannelHealPolicy(
  snapshot: ChannelHealthSnapshot,
  state: ChannelHealState,
  nowMs: number,
  options: {
    restartAfterConsecutiveDegraded: number;
    cooldownMs: number;
  },
): ChannelHealDecision {
  const nextState: ChannelHealState = {
    channels: {
      telegram: { ...state.channels.telegram },
      discord: { ...state.channels.discord },
      imessage: { ...state.channels.imessage },
      slack: { ...state.channels.slack },
    },
  };

  const actions: ChannelHealDecision["actions"] = [];

  for (const [channel, entry] of Object.entries(snapshot.entries) as Array<[GatewayChannelId, ChannelHealthEntry]>) {
    const previous = nextState.channels[channel] ?? defaultHealState();
    const nextChannelState: ChannelHealChannelState = {
      ...previous,
      status: entry.status,
      policy: entry.healPolicy,
      policyReason: entry.healReason,
      manualRepairSummary: entry.manualRepairSummary,
      manualRepairCommands: entry.manualRepairCommands,
    };

    if (!entry.configured || entry.status !== "degraded") {
      nextChannelState.consecutiveDegradedCount = 0;
      if (entry.status !== "degraded") {
        nextChannelState.lastAttemptStatus = previous.lastAttemptStatus === "scheduled"
          ? "idle"
          : previous.lastAttemptStatus;
      }
      nextState.channels[channel] = nextChannelState;
      continue;
    }

    nextChannelState.consecutiveDegradedCount = previous.status === "degraded"
      ? previous.consecutiveDegradedCount + 1
      : 1;

    if (entry.muted || entry.healPolicy !== "restart") {
      nextState.channels[channel] = nextChannelState;
      continue;
    }

    const cooledDown = previous.lastAttemptAt === 0 || nowMs - previous.lastAttemptAt >= options.cooldownMs;
    if (nextChannelState.consecutiveDegradedCount < options.restartAfterConsecutiveDegraded || !cooledDown) {
      nextState.channels[channel] = nextChannelState;
      continue;
    }

    nextChannelState.lastAttemptAt = nowMs;
    nextChannelState.lastAttemptStatus = "scheduled";
    nextChannelState.lastAttemptError = null;
    nextChannelState.attempts = previous.attempts + 1;
    nextState.channels[channel] = nextChannelState;

    actions.push({
      channel,
      policy: "restart",
      detail: entry.detail,
      reason: entry.healReason,
      muted: entry.muted,
      at: nowMs,
    });
  }

  return {
    actions,
    nextState,
  };
}

export function recordChannelHealAttemptResult(
  state: ChannelHealState,
  input: {
    channel: GatewayChannelId;
    succeeded: boolean;
    error?: string | null;
  },
): ChannelHealState {
  return {
    channels: {
      ...state.channels,
      [input.channel]: {
        ...(state.channels[input.channel] ?? defaultHealState()),
        lastAttemptStatus: input.succeeded ? "succeeded" : "failed",
        lastAttemptError: input.succeeded ? null : input.error ?? null,
      },
    },
  };
}
