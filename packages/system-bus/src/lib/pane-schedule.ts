export const PANE_SCHEDULE_VERSION = 1 as const;
export const PANE_SCHEDULE_REGISTRY_KEY = "pane:schedules:pending";
export const PANE_SCHEDULE_LATE_AFTER_MS = 5 * 60_000;

export type PaneScheduleVerb = "wake" | "spawn" | "revive";

export type PaneScheduleEntry = {
  version: typeof PANE_SCHEDULE_VERSION;
  scheduleId: string;
  verb: PaneScheduleVerb;
  at: string;
  target?: string;
  briefPath?: string;
  loopId?: string;
  prompt?: string;
  requestedBy: string;
  createdAt: string;
};

export type PaneScheduleInput = Omit<PaneScheduleEntry, "version" | "scheduleId" | "createdAt"> & {
  version?: number;
  scheduleId?: string;
  createdAt?: string;
};

export class PaneScheduleValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid pane schedule: ${issues.join("; ")}`);
    this.name = "PaneScheduleValidationError";
  }
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function validatePaneSchedule(input: unknown): PaneScheduleEntry {
  if (!input || typeof input !== "object") {
    throw new PaneScheduleValidationError(["event data must be an object"]);
  }

  const value = input as Record<string, unknown>;
  const issues: string[] = [];
  const version = value.version ?? PANE_SCHEDULE_VERSION;
  const scheduleId = optionalText(value.scheduleId);
  const verb = optionalText(value.verb) as PaneScheduleVerb | undefined;
  const at = optionalText(value.at);
  const requestedBy = optionalText(value.requestedBy);
  const createdAt = optionalText(value.createdAt);
  const target = optionalText(value.target);
  const briefPath = optionalText(value.briefPath);
  const loopId = optionalText(value.loopId);
  const prompt = optionalText(value.prompt);

  if (version !== PANE_SCHEDULE_VERSION) issues.push(`version must be ${PANE_SCHEDULE_VERSION}`);
  if (!scheduleId) issues.push("scheduleId is required");
  if (!verb || !(["wake", "spawn", "revive"] as const).includes(verb)) {
    issues.push("verb must be wake, spawn, or revive");
  }
  if (!at || !Number.isFinite(Date.parse(at))) issues.push("at must be a valid ISO date-time");
  if (at && Number.isFinite(Date.parse(at)) && new Date(at).toISOString() !== at) {
    issues.push("at must be normalized ISO-8601 (for example 2026-07-14T18:30:00.000Z)");
  }
  if (!requestedBy) issues.push("requestedBy is required");
  if (!createdAt || !Number.isFinite(Date.parse(createdAt))) issues.push("createdAt must be a valid date-time");

  if (verb === "wake" && !target) issues.push("wake requires target (pane or agent name)");
  if (verb === "spawn" && !briefPath) issues.push("spawn requires briefPath (--brief)");
  if (verb === "revive" && !loopId) issues.push("revive requires loopId (--loop)");
  if (verb !== "wake" && target) issues.push(`target is only valid with verb wake, not ${verb}`);
  if (verb !== "spawn" && briefPath) issues.push(`briefPath is only valid with verb spawn, not ${verb}`);
  if (verb !== "revive" && loopId) issues.push(`loopId is only valid with verb revive, not ${verb}`);

  if (issues.length > 0) throw new PaneScheduleValidationError(issues);

  return {
    version: PANE_SCHEDULE_VERSION,
    scheduleId: scheduleId!,
    verb: verb!,
    at: at!,
    ...(target ? { target } : {}),
    ...(briefPath ? { briefPath } : {}),
    ...(loopId ? { loopId } : {}),
    ...(prompt ? { prompt } : {}),
    requestedBy: requestedBy!,
    createdAt: new Date(createdAt!).toISOString(),
  };
}

export function isPaneScheduleLate(at: string, firedAtMs: number): boolean {
  return firedAtMs - Date.parse(at) > PANE_SCHEDULE_LATE_AFTER_MS;
}
