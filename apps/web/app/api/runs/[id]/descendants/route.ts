import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json(
    {
      ok: false,
      error: {
        code: "retired",
        message:
          "The Typesense Run descendants projection was retired. Query sessions.db through the Central operator tools.",
      },
    },
    { status: 410 },
  );
}
