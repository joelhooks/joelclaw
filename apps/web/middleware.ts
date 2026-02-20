import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // /slug.agent.md → internal rewrite to /slug/agent-md route handler
  const agentMdMatch = pathname.match(/^\/([\w-]+)\.agent\.md$/);
  if (agentMdMatch) {
    const url = request.nextUrl.clone();
    url.pathname = `/${agentMdMatch[1]}/agent-md`;
    return NextResponse.rewrite(url);
  }

  // /slug.md → internal rewrite to /slug/md route handler
  const mdMatch = pathname.match(/^\/([\w-]+)\.md$/);
  if (mdMatch) {
    const url = request.nextUrl.clone();
    url.pathname = `/${mdMatch[1]}/md`;
    return NextResponse.rewrite(url);
  }

  // /slug/agent-md → redirect to canonical /slug.agent.md
  const legacyAgentMatch = pathname.match(/^\/([\w-]+)\/agent-md$/);
  if (legacyAgentMatch) {
    const url = request.nextUrl.clone();
    url.pathname = `/${legacyAgentMatch[1]}.agent.md`;
    return NextResponse.redirect(url, 301);
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
  matcher: [
    "/:slug((?!_next|api|scripts|adrs|cool|network|feed|sitemap|robots|icon|opengraph)[\\w-]+).agent.md",
    "/:slug((?!_next|api|scripts|adrs|cool|network|feed|sitemap|robots|icon|opengraph)[\\w-]+).md",
    "/:slug((?!_next|api|scripts|adrs|cool|network|feed|sitemap|robots|icon|opengraph)[\\w-]+)/agent-md",
    "/:slug((?!_next|api|scripts|adrs|cool|network|feed|sitemap|robots|icon|opengraph)[\\w-]+)/md",
  ],
};
