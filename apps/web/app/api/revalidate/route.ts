import { revalidatePath, revalidateTag } from "next/cache";
import { NextResponse } from "next/server";

type RevalidateBody = {
  tag?: unknown;
  tags?: unknown;
  path?: unknown;
  paths?: unknown;
  secret?: unknown;
};

function toStringList(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }

  if (!Array.isArray(value)) return [];

  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function normalizePaths(paths: string[]): string[] {
  return paths
    .map((path) => (path.startsWith("/") ? path : `/${path}`))
    .filter((path, index, array) => array.indexOf(path) === index);
}

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

  const tags = Array.from(new Set([...toStringList(body.tag), ...toStringList(body.tags)]));
  const paths = normalizePaths(toStringList(body.path).concat(toStringList(body.paths)));

  if (tags.length === 0 && paths.length === 0) {
    return NextResponse.json({ error: "Missing revalidation target (tag/tags/path/paths)" }, { status: 400 });
  }

  for (const tag of tags) {
    revalidateTag(tag, "max");
  }

  for (const path of paths) {
    revalidatePath(path);
  }

  return NextResponse.json({
    revalidated: true,
    tags,
    paths,
  });
}
