"use client";

import { useEffect, useState } from "react";

function formatFull(date: Date) {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatRelative(date: Date) {
  const now = Date.now();
  const diff = now - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;

  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
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
  const [relative, setRelative] = useState(() => formatRelative(parsed));

  useEffect(() => {
    setRelative(formatRelative(parsed));
    const id = setInterval(() => setRelative(formatRelative(parsed)), 60_000);
    return () => clearInterval(id);
  }, [date]);

  return (
    <time dateTime={date} title={formatFull(parsed)} className={className}>
      {relative}
    </time>
  );
}
