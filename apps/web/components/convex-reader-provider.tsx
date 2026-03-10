"use client";

import { ConvexProvider, ConvexReactClient } from "convex/react";
import { type ReactNode, useRef } from "react";

/**
 * Lightweight Convex provider for read-only subscriptions (no auth).
 * Used by content pages for realtime change detection.
 */
export function ConvexReaderProvider({ children }: { children: ReactNode }) {
  const ref = useRef<ConvexReactClient | null>(null);
  const url = process.env.NEXT_PUBLIC_CONVEX_URL?.trim();
  if (!url) return null;

  if (!ref.current) {
    ref.current = new ConvexReactClient(url);
  }

  return <ConvexProvider client={ref.current}>{children}</ConvexProvider>;
}
