const SOURCE_IDENTITY_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const MAX_DATE_TIMESTAMP = 8_640_000_000_000_000;

export type HistoricalSourceCursorFields =
  | { readonly _tag: "Absent" }
  | { readonly _tag: "Invalid" }
  | {
      readonly _tag: "Valid";
      readonly sourceIdentity: string;
      readonly fromOffset: number;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function classifyHistoricalSourceCursorFields(
  value: unknown,
): HistoricalSourceCursorFields {
  if (!isRecord(value)) return { _tag: "Invalid" };
  const sourceIdentity = value.source_identity;
  const fromOffset = value.from_offset;
  if (sourceIdentity == null && fromOffset == null) return { _tag: "Absent" };
  if (
    typeof sourceIdentity !== "string" ||
    !SOURCE_IDENTITY_PATTERN.test(sourceIdentity) ||
    typeof fromOffset !== "number" ||
    !Number.isSafeInteger(fromOffset) ||
    fromOffset < 0
  ) {
    return { _tag: "Invalid" };
  }
  return { _tag: "Valid", sourceIdentity, fromOffset };
}

export function isHistoricalRunTimestamp(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_DATE_TIMESTAMP
  );
}

export function parseHistoricalSourceCursorClaim(
  value: unknown,
): { readonly run_id: string; readonly started_at: number } | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.run_id !== "string" ||
    value.run_id.length === 0 ||
    !isHistoricalRunTimestamp(value.started_at)
  ) {
    return null;
  }
  return { run_id: value.run_id, started_at: value.started_at };
}
