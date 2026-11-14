import { expect, mock, test } from "bun:test";
import { contentReviewApply } from "./content-review";

const handler = (contentReviewApply as unknown as { fn: (ctx: unknown) => Promise<unknown> }).fn;

test("content review still completes and emits its gateway signal without an outbound send", async () => {
  const notify = mock(async () => undefined);
  const sendEvent = mock(async () => {
    throw new Error("retired sends forbidden");
  });
  const steps: string[] = [];
  const values: Record<string, unknown> = {
    "fetch-article": {
      resourceId: "fixture-article",
      type: "post",
      content: "Original article",
      fields: {},
    },
    "fetch-review-feedback-state": {
      submittedComments: [{ resourceId: "comment-1" }],
      pendingFeedbackItems: [],
      historicalResolvedComments: [],
      historicalAppliedFeedbackItems: [],
    },
    "build-historical-assertions": [],
    "mark-feedback-processing": 0,
    "agent-edit": "Updated article",
    "normalize-edited-content": "Updated article",
    "verify-feedback-applied": [],
    "write-content-revision": "fixture-revision",
    "mark-comments-resolved": 1,
    "mark-feedback-by-verification": { strategy: "none", appliedUpdated: 0, failedUpdated: 0 },
  };
  const result = await handler({
    event: { data: { contentType: "post", contentSlug: "fixture-post" } },
    runId: "fixture-run",
    gateway: { notify },
    step: {
      run: async (id: string, fn: () => Promise<unknown>) => {
        steps.push(id);
        if (id === "notify-gateway-success" || id === "ack-feedback-received") return fn();
        return values[id];
      },
      sendEvent,
    },
  });
  expect(result).toMatchObject({
    status: "completed",
    revisionResourceId: "fixture-revision",
    resolvedCount: 1,
  });
  expect(steps).toContain("update-article-content");
  expect(steps).toContain("revalidate-cache");
  expect(notify).toHaveBeenCalledWith("content.review.applied", expect.any(Object));
  expect(sendEvent).not.toHaveBeenCalled();
});
