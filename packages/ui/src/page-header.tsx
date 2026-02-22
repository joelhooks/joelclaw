import type { JSX, ReactNode } from "react";

export function PageHeader({
  title,
  subtitle,
  badge,
  actions,
  count,
  className,
}: {
  title: string;
  subtitle?: string;
  badge?: ReactNode;
  actions?: ReactNode;
  count?: number | string;
  className?: string;
}): JSX.Element {
  return (
    <header className={`space-y-1 ${className ?? ""}`}>
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-neutral-100 sm:text-2xl">{title}</h1>
          {badge}
          {count != null && (
            <span className="font-mono text-xs text-neutral-500">{count}</span>
          )}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      {subtitle && (
        <p className="font-mono text-xs text-neutral-500 max-w-prose">{subtitle}</p>
      )}
    </header>
  );
}
