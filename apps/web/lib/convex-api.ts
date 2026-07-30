import {
  anyApi,
  type DefaultFunctionArgs,
  type FunctionReference,
} from "convex/server";
import type { GenericId } from "convex/values";

/**
 * The web app uses a small public slice of the private joelclaw-api Convex
 * deployment. Function references resolve by name at runtime, so the runtime
 * value is Convex's generic API proxy. This local type contract preserves the
 * checked client boundary without making Vercel install a sibling checkout.
 *
 * Source contract: joelhooks/joelclaw-api@ea41bf33.
 */

type PublicQuery<Args extends DefaultFunctionArgs, Result> = FunctionReference<
  "query",
  "public",
  Args,
  Result
>;

type PublicMutation<
  Args extends DefaultFunctionArgs,
  Result,
> = FunctionReference<
  "mutation",
  "public",
  Args,
  Result
>;

interface ContentResource {
  _id: GenericId<"contentResources">;
  _creationTime: number;
  contentHash?: string;
  deletedAt?: number;
  type: string;
  fields: unknown;
  createdAt: number;
  updatedAt: number;
  resourceId: string;
  searchText: string;
}

interface ReviewComment {
  _id: GenericId<"contentResources">;
  resourceId: string;
  paragraphId: string;
  content: string;
  status: string;
  threadId: string;
  parentCommentId: string;
  createdAt: number;
  updatedAt: number;
  position?: number;
}

type FeedbackStatus = "failed" | "pending" | "processing" | "applied";

interface FeedbackSummary {
  feedbackId: GenericId<"feedbackItems">;
  status: FeedbackStatus;
  createdAt: number;
  resolvedAt?: number;
}

interface WebConvexApi {
  auth: {
    isOwner: PublicQuery<Record<string, never>, boolean>;
  };
  contentResources: {
    getByResourceId: PublicQuery<
      { resourceId: string },
      ContentResource | null
    >;
    getContentHash: PublicQuery<
      { resourceId: string },
      { contentHash?: string; updatedAt: number } | null
    >;
    listByType: PublicQuery<
      { type: string; limit?: number },
      ContentResource[]
    >;
    searchByType: PublicQuery<
      { type: string; query: string; limit?: number },
      ContentResource[]
    >;
  };
  feedback: {
    listByResource: PublicQuery<{ resourceId: string }, FeedbackSummary[]>;
  };
  reviewComments: {
    getByContent: PublicQuery<{ contentId: string }, ReviewComment[]>;
    draftCount: PublicQuery<{ contentId: string }, number>;
    addComment: PublicMutation<
      {
        contentId: string;
        paragraphId: string;
        content: string;
        threadId?: string;
      },
      {
        commentId: GenericId<"contentResources">;
        resourceId: string;
      }
    >;
    updateComment: PublicMutation<
      { resourceId: string; content: string },
      { updated: boolean }
    >;
    deleteComment: PublicMutation<
      { resourceId: string },
      { deleted: boolean }
    >;
    submitReview: PublicMutation<
      { contentId: string },
      { submitted: number }
    >;
  };
}

export const api = anyApi as unknown as WebConvexApi;
