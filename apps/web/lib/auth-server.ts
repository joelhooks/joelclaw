import { convexBetterAuthNextJs } from "@convex-dev/better-auth/nextjs";

type AuthHelpers = ReturnType<typeof convexBetterAuthNextJs>;

type AsyncFetcher = (...args: readonly unknown[]) => Promise<unknown>;

let authHelpers: AuthHelpers | undefined;

function readEnv(...names: string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function deriveConvexSiteUrl(convexUrl: string) {
  try {
    const parsed = new URL(convexUrl);
    if (!parsed.hostname.endsWith(".convex.cloud")) return undefined;
    parsed.hostname = parsed.hostname.replace(/\.convex\.cloud$/, ".convex.site");
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function getAuthHelpers() {
  if (authHelpers) return authHelpers;

  const convexUrl = readEnv("CONVEX_URL", "NEXT_PUBLIC_CONVEX_URL");
  if (!convexUrl) {
    throw new Error("CONVEX_URL or NEXT_PUBLIC_CONVEX_URL is required for auth helpers");
  }

  const convexSiteUrl =
    readEnv("CONVEX_SITE_URL", "NEXT_PUBLIC_CONVEX_SITE_URL") ?? deriveConvexSiteUrl(convexUrl);
  if (!convexSiteUrl) {
    throw new Error(
      "CONVEX_SITE_URL or NEXT_PUBLIC_CONVEX_SITE_URL is required for auth helpers"
    );
  }

  authHelpers = convexBetterAuthNextJs({
    convexUrl,
    convexSiteUrl,
  }) as AuthHelpers;

  return authHelpers;
}

export const handler = {
  GET: (request: Request) => getAuthHelpers().handler.GET(request),
  POST: (request: Request) => getAuthHelpers().handler.POST(request),
};

export const isAuthenticated = async () => getAuthHelpers().isAuthenticated();

export const getToken = async () => getAuthHelpers().getToken();

export const preloadAuthQuery: AsyncFetcher = async (...args: any[]) => {
  return (getAuthHelpers().preloadAuthQuery as (...parameters: any[]) => Promise<unknown>)(...args);
};

export const fetchAuthQuery: AsyncFetcher = async (...args: any[]) => {
  return (getAuthHelpers().fetchAuthQuery as (...parameters: any[]) => Promise<unknown>)(...args);
};

export const fetchAuthMutation: AsyncFetcher = async (...args: any[]) => {
  return (getAuthHelpers().fetchAuthMutation as (...parameters: any[]) => Promise<unknown>)(...args);
};

export const fetchAuthAction: AsyncFetcher = async (...args: any[]) => {
  return (getAuthHelpers().fetchAuthAction as (...parameters: any[]) => Promise<unknown>)(...args);
};
