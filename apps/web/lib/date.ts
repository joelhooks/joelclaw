const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const MONTH_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

type DateParts = {
  year: number;
  month: number;
  day: number;
  hour: string;
  minute: string;
  second: string;
};

function parseDateParts(value: string): DateParts | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const match =
    trimmed.match(
      /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?/
    ) ?? null;
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }

  return {
    year,
    month,
    day,
    hour: match[4] ?? "00",
    minute: match[5] ?? "00",
    second: match[6] ?? "00",
  };
}

function dayOfWeek(year: number, month: number, day: number): number {
  // Zeller's congruence (Gregorian calendar), remapped to 0=Sun..6=Sat
  let y = year;
  let m = month;
  if (m < 3) {
    m += 12;
    y -= 1;
  }
  const k = y % 100;
  const j = Math.floor(y / 100);
  const h =
    (day +
      Math.floor((13 * (m + 1)) / 5) +
      k +
      Math.floor(k / 4) +
      Math.floor(j / 4) +
      5 * j) %
    7;
  return (h + 6) % 7;
}

export function toDateString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

export function dateSortKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^\d+$/.test(trimmed)) return trimmed.padStart(16, "0");
  return trimmed.replace(" ", "T");
}

export function compareDateDesc(a: string, b: string): number {
  return dateSortKey(b).localeCompare(dateSortKey(a));
}

export function formatDateStatic(
  value: string,
  opts?: { monthStyle?: "short" | "long"; includeYear?: boolean }
): string {
  const parts = parseDateParts(value);
  if (!parts) return value.trim();

  const monthName =
    opts?.monthStyle === "long"
      ? MONTH_LONG[parts.month - 1]
      : MONTH_SHORT[parts.month - 1];
  const includeYear = opts?.includeYear ?? true;

  return includeYear
    ? `${monthName} ${parts.day}, ${parts.year}`
    : `${monthName} ${parts.day}`;
}

export function formatRssPubDate(value: string): string {
  const parts = parseDateParts(value);
  if (!parts) return "Thu, 01 Jan 1970 00:00:00 GMT";

  const weekday = WEEKDAY_SHORT[dayOfWeek(parts.year, parts.month, parts.day)];
  const month = MONTH_SHORT[parts.month - 1];
  const dd = String(parts.day).padStart(2, "0");

  return `${weekday}, ${dd} ${month} ${parts.year} ${parts.hour}:${parts.minute}:${parts.second} GMT`;
}
