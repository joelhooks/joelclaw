/**
 * Static date display — no client JS, no CLS.
 *
 * Previously "use client" with useState/useEffect for relative times
 * ("2d ago"). Caused CLS on hydration because server and client
 * rendered different strings. Static dates are deterministic.
 */
import { formatDateStatic } from "@/lib/date";

export function RelativeTime({
  date,
  className,
}: {
  date: string;
  className?: string;
}) {
  const title = formatDateStatic(date, { monthStyle: "long", includeYear: true });
  const label = formatDateStatic(date, { monthStyle: "short", includeYear: true });

  return (
    <time dateTime={date} title={title} className={className}>
      {label}
    </time>
  );
}
