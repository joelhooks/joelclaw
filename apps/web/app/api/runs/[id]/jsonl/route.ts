import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json(
    {
      ok: false,
      error: {
        code: "retired",
        message:
          "The web Run JSONL route was retired. Read the authoritative Run blob through the Central operator tools.",
      },
    },
    { status: 410 },
  );
}
