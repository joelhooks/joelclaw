export const MORNING_DIGEST_MARKER = "[gateway-morning-digest]" as const;
export const MORNING_DIGEST_TARGET = "gateway" as const;
export const MORNING_DIGEST_TIME_ZONE = "America/Los_Angeles" as const;

export type MorningDigestCommandResult = { stdout: string; stderr: string };
export type MorningDigestCommandRunner = (
  argv: string[],
) => Promise<MorningDigestCommandResult>;

const MORNING_DIGEST_PROMPT = [
  MORNING_DIGEST_MARKER,
  "Compose the morning digest from live state now.",
  "Re-check every candidate, then lead with waiting on Joel and put handled quietly below the fold.",
  "Use roles/gateway.md for the delivery bar, context, thread, project, successor-arm, and current-schedule acknowledgement rules.",
].join(" ");

async function command(argv: string[]): Promise<MorningDigestCommandResult> {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${argv.join(" ")} exited ${exitCode}: ${stderr.trim() || stdout.trim()}`);
  }
  return { stdout, stderr };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseEnvelope(raw: string): Record<string, unknown> {
  const parsed = object(JSON.parse(raw));
  if (!parsed) throw new Error("command did not return a JSON object");
  if (parsed.ok === false) throw new Error(`command returned ok=false: ${raw}`);
  return parsed;
}

function findString(value: unknown, key: string): string | undefined {
  const record = object(value);
  if (record) {
    if (typeof record[key] === "string" && record[key].trim()) return record[key].trim();
    for (const child of Object.values(record)) {
      const found = findString(child, key);
      if (found) return found;
    }
  } else if (Array.isArray(value)) {
    for (const child of value) {
      const found = findString(child, key);
      if (found) return found;
    }
  }
  return undefined;
}

function containsSchedule(value: unknown, scheduleId: string): boolean {
  if (typeof value === "string") return value === scheduleId || value.includes(scheduleId);
  if (Array.isArray(value)) return value.some((item) => containsSchedule(item, scheduleId));
  const record = object(value);
  return record ? Object.values(record).some((item) => containsSchedule(item, scheduleId)) : false;
}

function findFutureMorningDigestSchedule(
  value: unknown,
  nowMs: number,
): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFutureMorningDigestSchedule(item, nowMs);
      if (found) return found;
    }
    return undefined;
  }
  const record = object(value);
  if (!record) return undefined;
  if (
    record.verb === "wake"
    && record.target === MORNING_DIGEST_TARGET
    && typeof record.at === "string"
    && Date.parse(record.at) > nowMs
    && typeof record.prompt === "string"
    && record.prompt.includes(MORNING_DIGEST_MARKER)
  ) {
    return record;
  }
  for (const item of Object.values(record)) {
    const found = findFutureMorningDigestSchedule(item, nowMs);
    if (found) return found;
  }
  return undefined;
}

type DateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const losAngelesFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: MORNING_DIGEST_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function losAngelesParts(date: Date): DateParts {
  const values = Object.fromEntries(
    losAngelesFormatter.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number.parseInt(part.value, 10)]),
  ) as Partial<DateParts>;
  if (
    !Number.isFinite(values.year)
    || !Number.isFinite(values.month)
    || !Number.isFinite(values.day)
    || !Number.isFinite(values.hour)
    || !Number.isFinite(values.minute)
    || !Number.isFinite(values.second)
  ) {
    throw new Error(`could not resolve ${MORNING_DIGEST_TIME_ZONE} clock parts`);
  }
  return values as DateParts;
}

function wallClockEpoch(parts: DateParts): number {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
}

function losAngelesWallClockToDate(parts: DateParts): Date {
  const desiredWallClock = wallClockEpoch(parts);
  let instant = desiredWallClock;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actualWallClock = wallClockEpoch(losAngelesParts(new Date(instant)));
    const correction = desiredWallClock - actualWallClock;
    if (correction === 0) return new Date(instant);
    instant += correction;
  }
  throw new Error(`could not resolve ${MORNING_DIGEST_TIME_ZONE} wall clock`);
}

export function nextMorningDigestAt(now: Date = new Date()): Date {
  const local = losAngelesParts(now);
  const afterToday = local.hour > 7 || (local.hour === 7 && local.minute >= 30);
  const localDate = new Date(Date.UTC(local.year, local.month - 1, local.day + (afterToday ? 1 : 0)));
  return losAngelesWallClockToDate({
    year: localDate.getUTCFullYear(),
    month: localDate.getUTCMonth() + 1,
    day: localDate.getUTCDate(),
    hour: 7,
    minute: 30,
    second: 0,
  });
}

export async function scheduleMorningDigest(
  runCommand: MorningDigestCommandRunner = command,
  now: Date = new Date(),
): Promise<{ scheduleId: string; at: string; target: typeof MORNING_DIGEST_TARGET }> {
  const before = parseEnvelope((await runCommand([
    "joelclaw",
    "wake",
    "list",
    "--format",
    "json",
  ])).stdout);
  const existing = findFutureMorningDigestSchedule(before, now.getTime());
  const existingScheduleId = existing ? findString(existing, "scheduleId") : undefined;
  if (existing && existingScheduleId && typeof existing.at === "string") {
    return {
      scheduleId: existingScheduleId,
      at: existing.at,
      target: MORNING_DIGEST_TARGET,
    };
  }

  const at = nextMorningDigestAt(now).toISOString();
  const created = parseEnvelope((await runCommand([
    "joelclaw",
    "wake",
    "at",
    at,
    "--verb",
    "wake",
    "--target",
    MORNING_DIGEST_TARGET,
    "--prompt",
    MORNING_DIGEST_PROMPT,
    "--format",
    "json",
  ])).stdout);
  const scheduleId = findString(created, "scheduleId");
  if (!scheduleId) throw new Error("wake registry accepted no scheduleId");

  try {
    const listed = parseEnvelope((await runCommand([
      "joelclaw",
      "wake",
      "list",
      "--format",
      "json",
    ])).stdout);
    if (!containsSchedule(listed, scheduleId)) {
      throw new Error(`wake registry readback did not contain ${scheduleId}`);
    }
  } catch (error) {
    try {
      parseEnvelope((await runCommand([
        "joelclaw",
        "wake",
        "cancel",
        scheduleId,
        "--format",
        "json",
      ])).stdout);
      const afterCancel = parseEnvelope((await runCommand([
        "joelclaw",
        "wake",
        "list",
        "--format",
        "json",
      ])).stdout);
      if (containsSchedule(afterCancel, scheduleId)) {
        throw new Error(`wake registry still contains ${scheduleId} after cancellation`);
      }
    } catch (cancelError) {
      throw new Error(
        `morning digest schedule ${scheduleId} could not be verified or cancelled: ${String(cancelError)}`,
        { cause: error },
      );
    }
    throw error;
  }

  return { scheduleId, at, target: MORNING_DIGEST_TARGET };
}
