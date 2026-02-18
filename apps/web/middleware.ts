import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // /slug.md → internal rewrite to /slug/md route handler
  const mdMatch = pathname.match(/^\/([\w-]+)\.md$/);
  if (mdMatch) {
    const url = request.nextUrl.clone();
    url.pathname = `/${mdMatch[1]}/md`;
    return NextResponse.rewrite(url);
  }

  // /slug/md → redirect to canonical /slug.md
  const legacyMatch = pathname.match(/^\/([\w-]+)\/md$/);
  if (legacyMatch) {
    const url = request.nextUrl.clone();
    url.pathname = `/${legacyMatch[1]}.md`;
    return NextResponse.redirect(url, 301);
  }
}

export const config = {
  matcher: ["/:slug((?!_next|api|scripts|adrs|cool|network|feed|sitemap|robots|icon|opengraph)[\\w-]+).md", "/:slug((?!_next|api|scripts|adrs|cool|network|feed|sitemap|robots|icon|opengraph)[\\w-]+)/md"],
};
