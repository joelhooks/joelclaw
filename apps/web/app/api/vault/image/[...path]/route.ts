/**
 * Serve vault images for authenticated users.
 * GET /api/vault/image/{path} → reads from ~/Vault/{path}
 */
import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth-server";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

const VAULT_PATH = process.env.VAULT_PATH || join(process.env.HOME || "/Users/joel", "Vault");

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
};

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const authed = await isAuthenticated().catch(() => false);
  if (!authed) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { path } = await params;
  const imagePath = path.join("/");
  const fullPath = join(VAULT_PATH, imagePath);

  // Security: ensure path stays within vault
  if (!fullPath.startsWith(VAULT_PATH)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const ext = extname(fullPath).toLowerCase();
  const mime = MIME_TYPES[ext];
  if (!mime) {
    return NextResponse.json({ error: "Not an image" }, { status: 400 });
  }

  if (!existsSync(fullPath)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const data = readFileSync(fullPath);
    return new NextResponse(new Uint8Array(data), {
      headers: {
        "Content-Type": mime,
        "Cache-Control": "public, max-age=86400, immutable",
      },
    });
  } catch {
    return NextResponse.json({ error: "Read failed" }, { status: 500 });
  }
}
