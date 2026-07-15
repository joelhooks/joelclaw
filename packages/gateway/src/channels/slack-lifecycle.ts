export type SlackSocketLifecycleState =
  | "connecting"
  | "authenticated"
  | "connected"
  | "reconnecting"
  | "disconnecting"
  | "disconnected";

export type SlackSocketLifecycle = {
  state: SlackSocketLifecycleState;
  lastTransitionAt: number;
  lastConnectedAt: number | null;
  reconnectCount: number;
};

export function initialSlackSocketLifecycle(now = Date.now()): SlackSocketLifecycle {
  return {
    state: "disconnected",
    lastTransitionAt: now,
    lastConnectedAt: null,
    reconnectCount: 0,
  };
}

export function transitionSlackSocketLifecycle(
  current: SlackSocketLifecycle,
  state: SlackSocketLifecycleState,
  now = Date.now(),
): SlackSocketLifecycle {
  return {
    state,
    lastTransitionAt: now,
    lastConnectedAt: state === "connected" ? now : current.lastConnectedAt,
    reconnectCount: current.reconnectCount + (state === "reconnecting" ? 1 : 0),
  };
}
