import { convexBetterAuthNextJs } from "@convex-dev/better-auth/nextjs";

type AuthHelpers = ReturnType<typeof convexBetterAuthNextJs>;

type AsyncFetcher = (...args: readonly unknown[]) => Promise<unknown>;

const authHelpers = convexBetterAuthNextJs({
  convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL!,
  convexSiteUrl: process.env.NEXT_PUBLIC_CONVEX_SITE_URL!,
}) as AuthHelpers;

export const { handler, isAuthenticated, getToken } = authHelpers;

export const preloadAuthQuery: AsyncFetcher = async (...args: any[]) => {
  return (authHelpers.preloadAuthQuery as (...parameters: any[]) => Promise<unknown>)(...args);
};

export const fetchAuthQuery: AsyncFetcher = async (...args: any[]) => {
  return (authHelpers.fetchAuthQuery as (...parameters: any[]) => Promise<unknown>)(...args);
};

export const fetchAuthMutation: AsyncFetcher = async (...args: any[]) => {
  return (authHelpers.fetchAuthMutation as (...parameters: any[]) => Promise<unknown>)(...args);
};

export const fetchAuthAction: AsyncFetcher = async (...args: any[]) => {
  return (authHelpers.fetchAuthAction as (...parameters: any[]) => Promise<unknown>)(...args);
};
