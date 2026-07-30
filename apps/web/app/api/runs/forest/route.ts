import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json(
    {
      ok: false,
      error: {
        code: "retired",
        message:
          "The Typesense Run forest projection was retired. Use `joelclaw sessions search` against sessions.db.",
      },
    },
    { status: 410 },
  );
}
