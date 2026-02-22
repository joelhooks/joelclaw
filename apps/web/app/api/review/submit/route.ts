/**
 * POST /api/review/submit
 *
 * Fires a content/review.submitted Inngest event.
 * Called by the ReviewSheet after marking drafts as submitted in Convex.
 */
import { NextResponse } from "next/server";

const INNGEST_EVENT_URL =
  process.env.INNGEST_EVENT_URL ?? "http://127.0.0.1:3111/e/local";

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

    const res = await fetch(INNGEST_EVENT_URL, {
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
