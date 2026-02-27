import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";

type RevalidateBody = {
  tag?: unknown;
};

export async function POST(request: Request) {
  const expectedSecret = process.env.REVALIDATION_SECRET;
  const providedSecret = request.headers.get("x-revalidation-secret");

  if (!expectedSecret || providedSecret !== expectedSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: RevalidateBody;
  try {
    body = (await request.json()) as RevalidateBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const tag = typeof body.tag === "string" ? body.tag.trim() : "";
  if (!tag) {
    return NextResponse.json({ error: "Missing tag" }, { status: 400 });
  }

  revalidateTag(tag);

  return NextResponse.json({ revalidated: true });
}
