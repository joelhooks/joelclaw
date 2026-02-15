import type { Metadata } from "next";
import type { SearchParams } from "nuqs/server";
import { getAllAdrs } from "../../lib/adrs";
import { SITE_NAME } from "../../lib/constants";
import { loadAdrSearchParams } from "./search-params";
import { AdrListWithFilters } from "./adr-list";

export const metadata: Metadata = {
  title: `ADRs — ${SITE_NAME}`,
  description:
    "Architecture Decision Records — how this system is built and why.",
};

type Props = {
  searchParams: Promise<SearchParams>;
};

export default async function AdrsPage({ searchParams }: Props) {
  const { status } = await loadAdrSearchParams(searchParams);
  const allAdrs = getAllAdrs();

  const counts = allAdrs.reduce(
    (acc, a) => {
      acc[a.status] = (acc[a.status] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  const allStatuses = Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .map(([s]) => s);

  return (
    <>
      <header className="mb-0">
        <h1 className="text-2xl font-bold tracking-tight">
          Architecture Decision Records
        </h1>
        <p className="mt-2 text-sm text-neutral-500">
          How this system is built and why. Every decision that changes the
          architecture gets written down.
        </p>
      </header>
      <AdrListWithFilters
        adrs={allAdrs}
        counts={counts}
        allStatuses={allStatuses}
      />
    </>
  );
}
