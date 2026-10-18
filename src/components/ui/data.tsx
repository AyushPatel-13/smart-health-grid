import Link from "next/link";
import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn, type Tone } from "./primitives";

// ---------------------------------------------------------------------------
// KPI card
// ---------------------------------------------------------------------------
const KPI_ACCENT: Record<Tone, string> = {
  neutral: "text-ink",
  info: "text-brand-700",
  success: "text-emerald-700",
  warning: "text-amber-700",
  critical: "text-red-700",
  teal: "text-teal-700",
  navy: "text-navy-900",
};

export function KpiCard({
  label,
  value,
  sub,
  icon,
  tone = "neutral",
  href,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  icon?: ReactNode;
  tone?: Tone;
  href?: string;
}) {
  const body = (
    <div className="flex h-full flex-col rounded-xl border border-line bg-surface p-4 transition-colors hover:border-brand-200">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[13px] font-medium text-ink-muted">{label}</p>
        {icon && <span className={cn("shrink-0", KPI_ACCENT[tone])}>{icon}</span>}
      </div>
      <p className={cn("tabular mt-2 text-2xl font-semibold tracking-tight", KPI_ACCENT[tone])}>{value}</p>
      {sub && <p className="mt-1 text-xs text-ink-muted">{sub}</p>}
    </div>
  );
  return href ? (
    <Link href={href} className="block rounded-xl">
      {body}
    </Link>
  ) : (
    body
  );
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------
export function Table({ children, caption, className }: { children: ReactNode; caption?: string; className?: string }) {
  return (
    <div className={cn("w-full overflow-x-auto", className)}>
      <table className="w-full min-w-[640px] border-collapse text-left text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        {children}
      </table>
    </div>
  );
}

export function Th({ children, className, align = "left" }: { children?: ReactNode; className?: string; align?: "left" | "right" | "center" }) {
  return (
    <th
      scope="col"
      className={cn(
        "border-b border-line bg-slate-50/80 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-ink-muted first:pl-4 last:pr-4 sm:first:pl-5 sm:last:pr-5",
        align === "right" && "text-right",
        align === "center" && "text-center",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({ children, className, align = "left" }: { children?: ReactNode; className?: string; align?: "left" | "right" | "center" }) {
  return (
    <td
      className={cn(
        "border-b border-line px-3 py-2.5 align-top first:pl-4 last:pr-4 sm:first:pl-5 sm:last:pr-5",
        align === "right" && "tabular text-right",
        align === "center" && "text-center",
        className,
      )}
    >
      {children}
    </td>
  );
}

// ---------------------------------------------------------------------------
// Pagination (link-based so it works without JavaScript)
// ---------------------------------------------------------------------------
export function Pagination({
  page,
  pageSize,
  total,
  makeHref,
  labels,
}: {
  page: number;
  pageSize: number;
  total: number;
  makeHref: (page: number) => string;
  labels: { showing: string; previous: string; next: string };
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;
  return (
    <nav className="flex items-center justify-between gap-3 px-4 py-3 text-[13px] text-ink-muted sm:px-5" aria-label="Pagination">
      <span>{labels.showing}</span>
      <div className="flex gap-1">
        {page > 1 ? (
          <Link className="inline-flex items-center rounded-md px-2 py-1 ring-1 ring-line hover:bg-slate-50" href={makeHref(page - 1)}>
            <ChevronLeft className="size-4" aria-hidden />
            {labels.previous}
          </Link>
        ) : null}
        {page < pages ? (
          <Link className="inline-flex items-center rounded-md px-2 py-1 ring-1 ring-line hover:bg-slate-50" href={makeHref(page + 1)}>
            {labels.next}
            <ChevronRight className="size-4" aria-hidden />
          </Link>
        ) : null}
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Link tabs (URL-driven)
// ---------------------------------------------------------------------------
export function LinkTabs({ tabs, active }: { tabs: { key: string; label: ReactNode; href: string; count?: number }[]; active: string }) {
  return (
    <div className="no-print -mx-4 mb-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <nav className="flex min-w-max gap-1 border-b border-line" aria-label="Tabs">
        {tabs.map((tab) => {
          const isActive = tab.key === active;
          return (
            <Link
              key={tab.key}
              href={tab.href}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium",
                isActive ? "border-brand-600 text-brand-700" : "border-transparent text-ink-muted hover:text-ink",
              )}
            >
              {tab.label}
              {tab.count ? (
                <span className="rounded-full bg-red-100 px-1.5 text-[11px] font-semibold text-red-700">{tab.count}</span>
              ) : null}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

// ---------------------------------------------------------------------------
// GET filter form (works without JavaScript; good on low bandwidth)
// ---------------------------------------------------------------------------
export function FilterForm({ children, applyLabel, resetHref, resetLabel }: { children: ReactNode; applyLabel: string; resetHref: string; resetLabel: string }) {
  return (
    <form method="get" className="no-print mb-4 flex flex-wrap items-end gap-3 rounded-xl border border-line bg-surface p-3">
      {children}
      <div className="flex gap-2">
        <button type="submit" className="h-9 rounded-lg bg-brand-600 px-3.5 text-sm font-medium text-white hover:bg-brand-700">
          {applyLabel}
        </button>
        <Link href={resetHref} className="inline-flex h-9 items-center rounded-lg px-3 text-sm text-ink-muted ring-1 ring-inset ring-line hover:bg-slate-50">
          {resetLabel}
        </Link>
      </div>
    </form>
  );
}

export function FilterSelect({
  name,
  label,
  value,
  options,
}: {
  name: string;
  label: string;
  value: string | undefined;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="flex min-w-[140px] flex-col gap-1 text-xs font-medium text-ink-muted">
      {label}
      <select name={name} defaultValue={value ?? ""} className="h-9 rounded-lg border border-line bg-white px-2 text-sm text-ink">
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function FilterInput({ name, label, value, placeholder, type = "search" }: { name: string; label: string; value?: string; placeholder?: string; type?: string }) {
  return (
    <label className="flex min-w-[180px] flex-1 flex-col gap-1 text-xs font-medium text-ink-muted sm:max-w-xs">
      {label}
      <input
        type={type}
        name={name}
        defaultValue={value ?? ""}
        placeholder={placeholder}
        className="h-9 rounded-lg border border-line bg-white px-2.5 text-sm text-ink placeholder:text-ink-faint"
      />
    </label>
  );
}
