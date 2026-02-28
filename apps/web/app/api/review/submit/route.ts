/**
 * POST /api/review/submit
 *
 * Fires a content/review.submitted Inngest event.
 * Called by the ReviewSheet after marking drafts as submitted in Convex.
 */
import { NextResponse } from "next/server";

const DEFAULT_INNGEST_EVENT_URL = "https://panda.tail7af24.ts.net:3111/e/local";
const INNGEST_EVENT_URL = process.env.INNGEST_EVENT_URL ?? DEFAULT_INNGEST_EVENT_URL;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { contentSlug, contentType } = body as {
      contentSlug?: string;
      contentType?: string;
    };

    if (!contentSlug || !contentType) {
      return NextResponse.json(
        { error: "contentSlug and contentType are required" },
        { status: 400 },
      );
    }

    let res: Response;
    try {
      res = await fetch(INNGEST_EVENT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "content/review.submitted",
          data: {
            contentSlug,
            contentType,
            source: "joelclaw-web",
          },
        }),
      });
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "Unable to reach Inngest event endpoint";
      console.error("Inngest event endpoint unreachable:", error);
      return NextResponse.json(
        { error: "Inngest unavailable", detail },
        { status: 502 },
      );
    }

    if (!res.ok) {
      const text = await res.text();
      console.error("Inngest event send failed:", text);
      return NextResponse.json(
        { error: "Failed to send event", detail: text },
        { status: 502 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Submit review error:", err);
    return NextResponse.json(
      { error: "Internal error" },
      { status: 500 },
    );
  }
}
