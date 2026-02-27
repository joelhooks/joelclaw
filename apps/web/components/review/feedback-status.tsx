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
    <div className="fixed bottom-5 right-5 z-40 rounded-md border border-amber-400/30 bg-amber-950/90 px-3 py-2 text-amber-100 shadow-lg backdrop-blur">
      <div className="flex items-center gap-2 text-sm font-mono">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span>revision in progress</span>
      </div>
      <p className="mt-0.5 text-[11px] text-amber-200/80">
        Processing {processingCount} feedback item
        {processingCount === 1 ? "" : "s"}.
      </p>
    </div>
  );
}
