import { PHASE_PRODUCTION_BUILD } from "next/constants";

const warnedScopes = new Set<string>();

export const STATIC_GENERATION_PLACEHOLDER_SLUG = "__joelclaw-static-build-placeholder__";

export function normalizeEnv(value: string | undefined): string {
  return value?.replace(/\\n/g, "").trim() ?? "";
}

export function readConvexUrl(): string {
  return normalizeEnv(process.env.CONVEX_URL) || normalizeEnv(process.env.NEXT_PUBLIC_CONVEX_URL);
}

export function readConvexDeployKey(): string {
  return normalizeEnv(process.env.CONVEX_DEPLOY_KEY);
}

export function shouldDegradeStaticGenerationWithoutConvex(): boolean {
  return !readConvexUrl() && process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD;
}

export function warnMissingConvexDuringBuild(scope: string): void {
  if (!shouldDegradeStaticGenerationWithoutConvex()) return;
  if (warnedScopes.has(scope)) return;

  warnedScopes.add(scope);
  console.warn(
    `[convex] ${scope}: CONVEX_URL/NEXT_PUBLIC_CONVEX_URL is missing during ${PHASE_PRODUCTION_BUILD}; returning an empty build-safe result so static generation can finish without filesystem reads.`,
  );
}

export function mapSlugsToStaticParams(slugs: readonly string[]): Array<{ slug: string }> {
  if (slugs.length > 0) {
    return slugs.map((slug) => ({ slug }));
  }

  return [{ slug: STATIC_GENERATION_PLACEHOLDER_SLUG }];
}

export function isStaticGenerationPlaceholderSlug(slug: string): boolean {
  return slug === STATIC_GENERATION_PLACEHOLDER_SLUG;
}
