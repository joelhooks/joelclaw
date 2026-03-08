const ADR_NUMBER_PATTERN = /^\d{4}$/;
const ADR_ROUTE_ALIAS_PATTERN = /^(?:adr-)?(\d{4})$/i;

type AdrSlugSource = {
  slug: string;
  number: string;
};

function normalizeAdrNumber(number: string): string | null {
  const trimmed = number.trim();
  return ADR_NUMBER_PATTERN.test(trimmed) ? trimmed : null;
}

export function toAdrRouteSlug(number: string): string {
  const normalized = normalizeAdrNumber(number);
  return normalized ? `adr-${normalized}` : number.trim().toLowerCase();
}

export function parseAdrRouteAlias(slug: string): string | null {
  const match = slug.trim().toLowerCase().match(ADR_ROUTE_ALIAS_PATTERN);
  return match?.[1] ?? null;
}

export function buildAdrRouteSlugs(adrs: readonly AdrSlugSource[]): string[] {
  const routeSlugs = new Set<string>();

  for (const adr of adrs) {
    const canonicalSlug = adr.slug.trim();
    if (canonicalSlug) routeSlugs.add(canonicalSlug);

    const routeSlug = toAdrRouteSlug(adr.number);
    if (routeSlug) routeSlugs.add(routeSlug);
  }

  return [...routeSlugs];
}

export function resolveAdrSourceSlug(
  routeSlug: string,
  adrs: readonly AdrSlugSource[],
): string | null {
  const aliasNumber = parseAdrRouteAlias(routeSlug);
  if (!aliasNumber) return routeSlug.trim();

  return adrs.find((adr) => adr.number === aliasNumber)?.slug ?? null;
}
