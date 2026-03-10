export const DISCOVERY_SITES = ["joelclaw", "wizardshit", "shared"] as const;
export const DISCOVERY_VISIBILITIES = [
  "public",
  "private",
  "archived",
  "migration-only",
] as const;

export type DiscoverySite = (typeof DISCOVERY_SITES)[number];
export type DiscoveryVisibility = (typeof DISCOVERY_VISIBILITIES)[number];

export type ResolvedDiscoveryRouting = {
  site: DiscoverySite;
  visibility: DiscoveryVisibility;
  canonicalSite: DiscoverySite;
  publishTargets: DiscoverySite[];
  routePolicy: DiscoveryVisibility;
  joelclawPath: string | null;
  joelclawUrl: string | null;
  defaultedSite: boolean;
  defaultedVisibility: boolean;
};

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function asSite(value: unknown): DiscoverySite | undefined {
  const raw = asOptionalString(value)?.toLowerCase();
  if (!raw) return undefined;
  return (DISCOVERY_SITES as readonly string[]).includes(raw)
    ? (raw as DiscoverySite)
    : undefined;
}

function asVisibility(value: unknown): DiscoveryVisibility | undefined {
  const raw = asOptionalString(value)?.toLowerCase();
  if (!raw) return undefined;
  return (DISCOVERY_VISIBILITIES as readonly string[]).includes(raw)
    ? (raw as DiscoveryVisibility)
    : undefined;
}

function asSiteArray(value: unknown): DiscoverySite[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => asSite(entry))
    .filter((entry): entry is DiscoverySite => Boolean(entry));
}

export function resolveDiscoveryRouting(input: {
  slug: string;
  privateFlag?: boolean;
  site?: unknown;
  visibility?: unknown;
  canonicalSite?: unknown;
  publishTargets?: unknown;
  routePolicy?: unknown;
}): ResolvedDiscoveryRouting {
  const defaultedSite = !asSite(input.site) && !asSite(input.canonicalSite);
  const defaultedVisibility = !asVisibility(input.visibility) && !asVisibility(input.routePolicy) && input.privateFlag !== true;

  const site = asSite(input.site) ?? asSite(input.canonicalSite) ?? "joelclaw";
  const canonicalSite = asSite(input.canonicalSite) ?? site;
  const visibility = input.privateFlag === true
    ? "private"
    : asVisibility(input.visibility) ?? asVisibility(input.routePolicy) ?? "public";

  const publishTargets = Array.from(
    new Set(
      (asSiteArray(input.publishTargets).length > 0
        ? asSiteArray(input.publishTargets)
        : site === "shared"
          ? (["joelclaw", "wizardshit"] as DiscoverySite[])
          : [site]),
    ),
  );

  const routePolicy = asVisibility(input.routePolicy) ?? visibility;
  const joelclawPath = visibility === "public" && publishTargets.includes("joelclaw")
    ? `/cool/${input.slug}`
    : null;
  const joelclawUrl = joelclawPath ? `https://joelclaw.com${joelclawPath}` : null;

  return {
    site,
    visibility,
    canonicalSite,
    publishTargets,
    routePolicy,
    joelclawPath,
    joelclawUrl,
    defaultedSite,
    defaultedVisibility,
  };
}

export function discoveryPublishesToJoelclaw(routing: ResolvedDiscoveryRouting): boolean {
  return routing.visibility === "public" && routing.publishTargets.includes("joelclaw");
}

export function buildDiscoveryFinalLink(input: {
  slug: string;
  noteName: string;
  routing: ResolvedDiscoveryRouting;
}): string {
  return input.routing.joelclawUrl
    ?? `vault:Resources/discoveries/${input.noteName}.md`;
}
