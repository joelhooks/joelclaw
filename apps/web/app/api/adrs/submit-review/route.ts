/**
 * POST /api/adrs/submit-review — ADR-0106
 *
 * Fires an Inngest event to trigger the agent review loop.
 * Called after comments are marked "submitted" in Convex.
 *
 * Auth: requires valid session (better-auth token).
 * Sends adr/review.submitted to the local Inngest server.
 */
import { NextRequest, NextResponse } from "next/server";

const INNGEST_EVENT_URL =
  process.env.INNGEST_EVENT_URL ?? "http://127.0.0.1:3111/e/local";
const INNGEST_EVENT_KEY = process.env.INNGEST_EVENT_KEY ?? "";

export async function POST(req: NextRequest) {
  // Basic auth check — verify session cookie exists
  // Full owner check happens in Convex mutations; this is a belt-and-suspenders gate
  const token = req.cookies.get("better-auth.session_token")?.value;
  if (!token) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: { adrSlug?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { adrSlug } = body;
  if (!adrSlug || typeof adrSlug !== "string") {
    return NextResponse.json(
      { error: "adrSlug is required" },
      { status: 400 },
    );
  }

  // Send Inngest event
  try {
    const res = await fetch(INNGEST_EVENT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(INNGEST_EVENT_KEY
          ? { Authorization: `Bearer ${INNGEST_EVENT_KEY}` }
          : {}),
      },
      body: JSON.stringify({
        name: "adr/review.submitted",
        data: {
          adrSlug,
          source: "joelclaw-web",
        },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error("Inngest event send failed:", res.status, text);
      return NextResponse.json(
        { error: "Failed to send event", detail: text },
        { status: 502 },
      );
    }

    const result = await res.json();
    return NextResponse.json({
      ok: true,
      eventIds: result.ids ?? [],
    });
  } catch (err) {
    console.error("Inngest event send error:", err);
    return NextResponse.json(
      { error: "Inngest unreachable" },
      { status: 503 },
    );
  }
}
