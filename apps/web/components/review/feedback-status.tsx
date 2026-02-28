"use client";

import { useQuery } from "convex/react";
import { Loader2 } from "lucide-react";
import { api } from "@/convex/_generated/api";

interface FeedbackStatusProps {
  resourceId: string;
}

export function FeedbackStatus({ resourceId }: FeedbackStatusProps) {
  const feedbackItems = useQuery(api.feedback.listByResource, { resourceId });
  const processingCount =
    feedbackItems?.filter((item) => item.status === "processing").length ?? 0;

  if (processingCount === 0) return null;

  return (
    <div className="mx-auto mb-4 w-full max-w-2xl rounded-md border border-amber-400/40 bg-amber-950/90 px-4 py-3 text-amber-100 shadow-lg backdrop-blur">
      <div className="flex items-center gap-2 text-sm font-mono">
        <span className="relative inline-flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-300/70" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-200" />
        </span>
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span className="animate-pulse">
          🔄 Agent reviewing your feedback — comments paused until complete
        </span>
      </div>
      <p className="mt-0.5 text-[11px] text-amber-200/80">
        Processing {processingCount} feedback item
        {processingCount === 1 ? "" : "s"}.
      </p>
    </div>
  );
}
