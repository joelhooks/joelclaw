import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";

type RevalidateBody = {
  tag?: unknown;
  secret?: unknown;
};

export async function POST(request: Request) {
  const expectedSecret = process.env.REVALIDATION_SECRET?.trim();
  if (!expectedSecret) {
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
  }

  let body: RevalidateBody;
  try {
    body = (await request.json()) as RevalidateBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const providedSecret = typeof body.secret === "string" ? body.secret.trim() : "";
  if (!providedSecret || providedSecret !== expectedSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const tag = typeof body.tag === "string" ? body.tag.trim() : "";
  if (!tag) {
    return NextResponse.json({ error: "Missing tag" }, { status: 400 });
  }

  revalidateTag(tag, "max");

  return NextResponse.json({ revalidated: true });
}
