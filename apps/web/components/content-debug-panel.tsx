"use client";

import { useEffect, useState } from "react";
import type { PostDiagnostics } from "@/lib/posts";

function hasTruthyParam(value: string | null): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function ContentDebugPanel({
  slug,
  diagnostics,
  filesystemFallbackEnabled,
}: {
  slug: string;
  diagnostics: PostDiagnostics;
  filesystemFallbackEnabled: boolean;
}) {
  const [enabled, setEnabled] = useState(false);
  const [reviewMode, setReviewMode] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const debugEnabled = hasTruthyParam(params.get("debug")) || hasTruthyParam(params.get("source"));
    const reviewEnabled = hasTruthyParam(params.get("review"));

    setEnabled(debugEnabled);
    setReviewMode(reviewEnabled);
  }, []);

  if (!enabled) return null;

  return (
    <details className="mt-4 rounded border border-neutral-800 bg-neutral-950/80 px-3 py-2 text-xs font-mono text-neutral-400" open>
      <summary className="cursor-pointer select-none text-neutral-300">content debug</summary>
      <div className="mt-2 space-y-1">
        <div>slug: {slug}</div>
        <div>source: {diagnostics.source}</div>
        <div>resourceId: {diagnostics.resourceId}</div>
        <div>hash: {diagnostics.contentHash}</div>
        <div>length: {diagnostics.contentLength}</div>
        <div>review mode: {reviewMode ? "on (?review=1)" : "off"}</div>
        <div>fs fallback: {filesystemFallbackEnabled ? "enabled" : "disabled"}</div>
        {diagnostics.contentUpdatedAt && (
          <div>content updatedAt: {new Date(diagnostics.contentUpdatedAt).toISOString()}</div>
        )}
      </div>
    </details>
  );
}
