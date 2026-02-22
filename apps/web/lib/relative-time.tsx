/**
 * Static date display — no client JS, no CLS.
 *
 * Previously "use client" with useState/useEffect for relative times
 * ("2d ago"). Caused CLS on hydration because server and client
 * rendered different strings. Static dates are deterministic.
 */

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatFull(date: Date): string {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function RelativeTime({
  date,
  className,
}: {
  date: string;
  className?: string;
}) {
  const parsed = new Date(date);

  return (
    <time dateTime={date} title={formatFull(parsed)} className={className}>
      {formatDate(parsed)}
    </time>
  );
}
