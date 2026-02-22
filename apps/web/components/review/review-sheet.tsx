"use client";

/**
 * ReviewSheet — full-page overlay showing all draft comments.
 *
 * ADR-0106. Generic — works for any content type.
 * Comments grouped by paragraph, with inline edit/delete.
 * Submit button fires the mutation then POST to the API route.
 */
import { useState, useCallback } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerFooter,
} from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Trash2, Pencil, Send, Loader2, CheckCircle2 } from "lucide-react";

interface ReviewSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contentId: string;
  contentType: string;
  contentSlug: string;
}

export function ReviewSheet({
  open,
  onOpenChange,
  contentId,
  contentType,
  contentSlug,
}: ReviewSheetProps) {
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");

  const allComments = useQuery(api.reviewComments.getByContent, { contentId });
  const submitReview = useMutation(api.reviewComments.submitReview);
  const updateComment = useMutation(api.reviewComments.updateComment);
  const deleteComment = useMutation(api.reviewComments.deleteComment);

  const drafts = allComments?.filter((c) => c.status === "draft") ?? [];

  // Group by paragraphId
  const grouped = drafts.reduce(
    (acc, comment) => {
      const key = comment.paragraphId;
      if (!acc[key]) acc[key] = [];
      acc[key]!.push(comment);
      return acc;
    },
    {} as Record<string, typeof drafts>,
  );

  const handleSubmit = useCallback(async () => {
    if (drafts.length === 0) return;
    setSubmitting(true);
    try {
      await submitReview({ contentId });

      const res = await fetch("/api/review/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentSlug, contentType }),
      });

      if (!res.ok) {
        console.error("Submit review failed:", await res.text());
      }

      setSubmitted(true);
      setTimeout(() => {
        onOpenChange(false);
        setSubmitted(false);
      }, 2000);
    } catch (err) {
      console.error("Submit review error:", err);
    } finally {
      setSubmitting(false);
    }
  }, [drafts.length, contentId, contentSlug, contentType, submitReview, onOpenChange]);

  const handleSaveEdit = useCallback(async () => {
    if (!editingId || !editContent.trim()) return;
    await updateComment({ resourceId: editingId, content: editContent.trim() });
    setEditingId(null);
    setEditContent("");
  }, [editingId, editContent, updateComment]);

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="border-neutral-800 bg-neutral-950 max-h-[92vh]">
        <div className="mx-auto w-full max-w-lg flex flex-col max-h-[88vh]">
          <DrawerHeader className="flex-shrink-0 border-b border-neutral-800/50 pb-3">
            <div className="flex items-center justify-between">
              <div>
                <DrawerTitle className="text-sm font-mono text-neutral-300 tracking-tight">
                  Review
                </DrawerTitle>
                <p className="mt-0.5 text-xs text-neutral-600 font-mono">
                  {contentType}:{contentSlug}
                </p>
              </div>
              <Badge
                variant="outline"
                className="border-claw/30 text-claw font-mono text-[10px] tabular-nums"
              >
                {drafts.length} comment{drafts.length !== 1 ? "s" : ""}
              </Badge>
            </div>
          </DrawerHeader>

          {/* Comments grouped by paragraph */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 scrollbar-thin">
            {submitted ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <CheckCircle2 className="w-8 h-8 text-emerald-500 mb-3" />
                <p className="text-sm text-neutral-300 font-mono">Review submitted</p>
                <p className="text-xs text-neutral-600 mt-1">
                  Agent will process and ping you on Telegram
                </p>
              </div>
            ) : drafts.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <p className="text-sm text-neutral-500 font-mono">No draft comments</p>
                <p className="text-xs text-neutral-600 mt-1">
                  Tap paragraphs to add comments
                </p>
              </div>
            ) : (
              Object.entries(grouped).map(([paragraphId, comments]) => (
                <div key={paragraphId} className="space-y-1.5">
                  <button
                    onClick={() => {
                      onOpenChange(false);
                      setTimeout(() => {
                        document
                          .getElementById(paragraphId)
                          ?.scrollIntoView({ behavior: "smooth", block: "center" });
                      }, 300);
                    }}
                    className="flex items-center gap-1.5 text-[10px] font-mono text-neutral-600 hover:text-claw/60 transition-colors"
                  >
                    <span className="w-1 h-1 rounded-full bg-neutral-700" />
                    #{paragraphId}
                  </button>

                  {comments.map((comment) => (
                    <div
                      key={comment.resourceId}
                      className="group relative rounded-md border border-neutral-800/40 bg-neutral-900/30 px-3 py-2 ml-2.5 border-l-2 border-l-claw/20"
                    >
                      {editingId === comment.resourceId ? (
                        <div className="space-y-2">
                          <Textarea
                            value={editContent}
                            onChange={(e) => setEditContent(e.target.value)}
                            className="min-h-[60px] resize-none border-neutral-700 bg-neutral-900 text-sm text-neutral-200 placeholder:text-neutral-600 focus-visible:ring-claw/30"
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                                e.preventDefault();
                                handleSaveEdit();
                              }
                            }}
                          />
                          <div className="flex gap-1.5 justify-end">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 px-2 text-[11px] text-neutral-500"
                              onClick={() => setEditingId(null)}
                            >
                              Cancel
                            </Button>
                            <Button
                              size="sm"
                              className="h-6 px-2 text-[11px] bg-claw/10 text-claw hover:bg-claw/20 border border-claw/20"
                              onClick={handleSaveEdit}
                            >
                              Save
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <p className="text-sm text-neutral-300 leading-relaxed whitespace-pre-wrap pr-12">
                            {comment.content}
                          </p>
                          <div className="absolute top-1.5 right-1.5 flex gap-0.5 opacity-0 group-hover:opacity-100 sm:transition-opacity">
                            <button
                              onClick={() => {
                                setEditingId(comment.resourceId);
                                setEditContent(comment.content);
                              }}
                              className="p-1 rounded text-neutral-600 hover:text-neutral-300 hover:bg-neutral-800 transition-colors"
                            >
                              <Pencil className="w-3 h-3" />
                            </button>
                            <button
                              onClick={() =>
                                deleteComment({ resourceId: comment.resourceId })
                              }
                              className="p-1 rounded text-neutral-600 hover:text-red-400 hover:bg-neutral-800 transition-colors"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>

          {!submitted && drafts.length > 0 && (
            <DrawerFooter className="flex-shrink-0 border-t border-neutral-800/50 pt-3">
              <Button
                onClick={handleSubmit}
                disabled={submitting}
                className="w-full bg-claw/10 text-claw hover:bg-claw/20 border border-claw/30 font-mono text-sm h-11 transition-all active:scale-[0.98]"
              >
                {submitting ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />
                    Submitting…
                  </>
                ) : (
                  <>
                    <Send className="w-3.5 h-3.5 mr-2" />
                    Submit Review · {drafts.length} comment
                    {drafts.length !== 1 ? "s" : ""}
                  </>
                )}
              </Button>
            </DrawerFooter>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
