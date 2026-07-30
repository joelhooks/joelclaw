import { NextResponse } from "next/server";

export function POST() {
  return NextResponse.json(
    {
      ok: false,
      error: {
        code: "retired",
        message:
          "The Typesense Run search route was retired. Use `joelclaw sessions search` against sessions.db.",
      },
    },
    { status: 410 },
  );
}
