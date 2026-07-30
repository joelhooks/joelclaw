import { NextResponse } from "next/server";

export function POST() {
  return NextResponse.json(
    {
      ok: false,
      error: {
        code: "retired",
        message:
          "The Vercel Run ingest route was retired. Machine hooks must post to the Central /api/runs endpoint.",
      },
    },
    { status: 410 },
  );
}
