/**
 * Guard for POST /api/review/submit (sec-20261103-014).
 *
 * The route fires a signed Inngest event that starts content review work, so
 * only the site owner may call it. Rate limiting runs first so a flood never
 * reaches the auth check. The owner check fails closed: any error refuses.
 * A limiter outage does not block the owner (the owner check still holds).
 */
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

export type ReviewSubmitDecision =
  | { ok: true }
  | { ok: false; status: 401 | 429; error: string };

export interface ReviewSubmitDeps {
  /** Resolves true only for the signed-in site owner. */
  isOwner: () => Promise<boolean>;
  /** Returns null when no limiter is configured. */
  limit: () => Promise<{ success: boolean } | null>;
}

export async function checkReviewSubmit(deps: ReviewSubmitDeps): Promise<ReviewSubmitDecision> {
  let rate: { success: boolean } | null = null;
  try {
    rate = await deps.limit();
  } catch (error) {
    console.warn("[review-submit] rate limiter unavailable:", error);
  }
  if (rate && !rate.success) {
    return { ok: false, status: 429, error: "Too many review submissions" };
  }

  let owner = false;
  try {
    owner = (await deps.isOwner()) === true;
  } catch {
    owner = false;
  }
  if (!owner) {
    return { ok: false, status: 401, error: "Only the site owner can submit reviews" };
  }
  return { ok: true };
}

export function clientIdentifier(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for") ?? "";
  const first = forwardedFor
    .split(",")
    .map((part) => part.trim())
    .find(Boolean);
  return first || request.headers.get("x-real-ip")?.trim() || "anonymous";
}

const RATE_LIMIT = 10;
const RATE_WINDOW = "1 m";
let ratelimit: Ratelimit | null | undefined;

export function getReviewSubmitRatelimit(): Ratelimit | null {
  if (ratelimit !== undefined) return ratelimit;
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    ratelimit = null;
    return ratelimit;
  }
  ratelimit = new Ratelimit({
    redis: new Redis({ url, token }),
    limiter: Ratelimit.slidingWindow(RATE_LIMIT, RATE_WINDOW),
    prefix: "rl:review-submit",
  });
  return ratelimit;
}
