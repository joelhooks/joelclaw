export type GatewayChannelId = "telegram" | "discord" | "imessage" | "slack";
export type ChannelHealthStatus = "healthy" | "degraded" | "disabled";
export type ChannelHealthEventKind = "degraded" | "recovered";

export type ChannelHealthEntryInput = {
  configured: boolean;
  healthy: boolean;
  detail: string;
  muted?: boolean;
  muteReason?: string | null;
};

export type ChannelHealthEntry = {
  channel: GatewayChannelId;
  status: ChannelHealthStatus;
  configured: boolean;
  healthy: boolean;
  detail: string;
  muted: boolean;
  muteReason: string | null;
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

function defaultChannelState(): ChannelHealthChannelState {
  return {
    status: "disabled",
    lastChangedAt: 0,
    lastEventAt: 0,
    lastRecoveredAt: 0,
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
