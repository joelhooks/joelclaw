import { Data } from "effect";

export class JournalSqlError extends Data.TaggedError("JournalSqlError")<{
  readonly code: "INVALID_IDENTIFIER" | "INVALID_DURATION";
  readonly value: string;
}> {}

export function sqlIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) {
    throw new JournalSqlError({ code: "INVALID_IDENTIFIER", value });
  }
  return value;
}

export function sqlString(value: string): string {
  return `'${value.replace(/\\/gu, "\\\\").replace(/'/gu, "\\'")}'`;
}

const DURATION_UNITS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

export function parseDuration(value: string): number {
  const match = /^(\d+)(ms|s|m|h|d|w)$/u.exec(value.trim());
  const amount = match?.[1] ? Number.parseInt(match[1], 10) : Number.NaN;
  const unit = match?.[2];
  const multiplier = unit ? DURATION_UNITS[unit] : undefined;
  if (!Number.isSafeInteger(amount) || amount <= 0 || multiplier === undefined) {
    throw new JournalSqlError({ code: "INVALID_DURATION", value });
  }
  const duration = amount * multiplier;
  if (!Number.isSafeInteger(duration)) {
    throw new JournalSqlError({ code: "INVALID_DURATION", value });
  }
  return duration;
}

export function qualifiedTable(database: string, table: string): string {
  return `${sqlIdentifier(database)}.${sqlIdentifier(table)}`;
}
