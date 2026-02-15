import type { Metadata } from "next";
import { Suspense } from "react";
import { getAllAdrs } from "../../lib/adrs";
import { SITE_NAME } from "../../lib/constants";
import { AdrListWithFilters } from "./adr-list";

export const metadata: Metadata = {
  title: `ADRs — ${SITE_NAME}`,
  description:
    "Architecture Decision Records — how this system is built and why.",
};

export default function AdrsPage() {
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
    .map(([status]) => status);

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
      <Suspense>
        <AdrListWithFilters
          adrs={allAdrs}
          counts={counts}
          allStatuses={allStatuses}
        />
      </Suspense>
    </>
  );
}
