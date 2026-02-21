import type { JSX, ReactNode } from "react";

/**
 * Responsive grid container that adapts column count to viewport width.
 *
 * Usage:
 *   <DataGrid columns={{ sm: 1, md: 2, lg: 3, xl: 4 }}>
 *     <MetricCard ... />
 *   </DataGrid>
 *
 * Preset shortcuts:
 *   columns="metrics"  → 1 / 2 / 2 / 4
 *   columns="panels"   → 1 / 1 / 2 / 2
 *   columns="dense"    → 2 / 2 / 3 / 4
 */

type ColumnPreset = "metrics" | "panels" | "dense";

type ColumnSpec = {
  sm?: number;
  md?: number;
  lg?: number;
  xl?: number;
};

const PRESETS: Record<ColumnPreset, string> = {
  metrics: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-4",
  panels: "grid-cols-1 md:grid-cols-2",
  dense: "grid-cols-2 lg:grid-cols-3 xl:grid-cols-4",
};

function columnsToClasses(spec: ColumnSpec): string {
  const parts: string[] = [];
  if (spec.sm) parts.push(`grid-cols-${spec.sm}`);
  if (spec.md) parts.push(`sm:grid-cols-${spec.md}`);
  if (spec.lg) parts.push(`lg:grid-cols-${spec.lg}`);
  if (spec.xl) parts.push(`xl:grid-cols-${spec.xl}`);
  return parts.join(" ");
}

export function DataGrid({
  columns = "metrics",
  gap = "gap-2",
  children,
  className,
}: {
  columns?: ColumnPreset | ColumnSpec;
  gap?: string;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  const colClasses =
    typeof columns === "string" ? PRESETS[columns] : columnsToClasses(columns);

  return (
    <div className={`grid ${colClasses} ${gap} ${className ?? ""}`}>
      {children}
    </div>
  );
}
