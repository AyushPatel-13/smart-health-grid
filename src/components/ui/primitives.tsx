import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { AlertTriangle, Inbox, Info, ShieldAlert, CheckCircle2 } from "lucide-react";

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------
export function Card({ className, children, ...rest }: ComponentProps<"section">) {
  return (
    <section className={cn("rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgba(15,27,45,0.04)]", className)} {...rest}>
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  subtitle,
  actions,
  id,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  id?: string;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
      <div className="min-w-0">
        <h2 id={id} className="text-[15px] font-semibold text-ink">
          {title}
        </h2>
        {subtitle && <p className="mt-0.5 text-[13px] text-ink-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("px-4 py-4 sm:px-5", className)}>{children}</div>;
}

// ---------------------------------------------------------------------------
// Page header
// ---------------------------------------------------------------------------
export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">{title}</h1>
        {subtitle && <p className="mt-1 max-w-3xl text-sm text-ink-muted">{subtitle}</p>}
      </div>
      {actions && <div className="no-print flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------
export type Tone = "neutral" | "info" | "success" | "warning" | "critical" | "teal" | "navy";

const TONES: Record<Tone, string> = {
  neutral: "bg-slate-100 text-slate-700 ring-slate-200",
  info: "bg-brand-50 text-brand-700 ring-brand-200",
  success: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  warning: "bg-amber-50 text-amber-800 ring-amber-200",
  critical: "bg-red-50 text-red-700 ring-red-200",
  teal: "bg-teal-50 text-teal-700 ring-teal-100",
  navy: "bg-navy-900 text-white ring-navy-900",
};

export function Badge({ tone = "neutral", children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Dot({ tone }: { tone: Tone }) {
  const color: Record<Tone, string> = {
    neutral: "bg-slate-400",
    info: "bg-brand-500",
    success: "bg-emerald-500",
    warning: "bg-amber-500",
    critical: "bg-red-600",
    teal: "bg-teal-600",
    navy: "bg-navy-900",
  };
  return <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", color[tone])} />;
}

// ---------------------------------------------------------------------------
// Buttons / links
// ---------------------------------------------------------------------------
type Variant = "primary" | "secondary" | "ghost" | "danger" | "teal";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-brand-600 text-white hover:bg-brand-700 disabled:bg-brand-600/50",
  secondary: "bg-white text-ink ring-1 ring-inset ring-line hover:bg-slate-50 disabled:text-ink-faint",
  ghost: "text-ink-muted hover:bg-slate-100 hover:text-ink",
  danger: "bg-red-600 text-white hover:bg-red-700 disabled:bg-red-600/50",
  teal: "bg-teal-600 text-white hover:bg-teal-700 disabled:bg-teal-600/50",
};

export function buttonClass(variant: Variant = "primary", size: "sm" | "md" = "md") {
  return cn(
    "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:cursor-not-allowed",
    size === "sm" ? "h-8 px-2.5 text-[13px]" : "h-9 px-3.5 text-sm",
    VARIANTS[variant],
  );
}

export function Button({
  variant = "primary",
  size = "md",
  className,
  ...rest
}: ComponentProps<"button"> & { variant?: Variant; size?: "sm" | "md" }) {
  return <button className={cn(buttonClass(variant, size), className)} {...rest} />;
}

export function ButtonLink({
  variant = "secondary",
  size = "md",
  className,
  ...rest
}: ComponentProps<typeof Link> & { variant?: Variant; size?: "sm" | "md" }) {
  return <Link className={cn(buttonClass(variant, size), className)} {...rest} />;
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------
export function EmptyState({ title, body, icon }: { title: ReactNode; body?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
      <div className="mb-2 text-ink-faint">{icon ?? <Inbox className="size-7" aria-hidden />}</div>
      <p className="text-sm font-medium text-ink">{title}</p>
      {body && <p className="mt-1 max-w-sm text-[13px] text-ink-muted">{body}</p>}
    </div>
  );
}

export function Notice({ tone = "info", children, className }: { tone?: "info" | "warning" | "critical" | "success"; children: ReactNode; className?: string }) {
  const map = {
    info: { cls: "border-brand-200 bg-brand-50 text-brand-800", Icon: Info },
    warning: { cls: "border-amber-200 bg-amber-50 text-amber-900", Icon: AlertTriangle },
    critical: { cls: "border-red-200 bg-red-50 text-red-800", Icon: ShieldAlert },
    success: { cls: "border-emerald-200 bg-emerald-50 text-emerald-900", Icon: CheckCircle2 },
  }[tone];
  return (
    <div role={tone === "critical" ? "alert" : "status"} className={cn("flex items-start gap-2 rounded-lg border px-3 py-2 text-[13px]", map.cls, className)}>
      <map.Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Key/value list
// ---------------------------------------------------------------------------
export function DefinitionList({ items, className }: { items: { label: ReactNode; value: ReactNode }[]; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2", className)}>
      {items.map((it, i) => (
        <div key={i} className="flex justify-between gap-3 border-b border-dashed border-line py-1.5 last:border-0 sm:block sm:border-0 sm:py-0">
          <dt className="text-[13px] text-ink-muted">{it.label}</dt>
          <dd className="tabular text-right font-medium text-ink sm:mt-0.5 sm:text-left">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------------------
// Meter (0..1)
// ---------------------------------------------------------------------------
export function Meter({ value, tone = "info", label }: { value: number | null; tone?: Tone; label: string }) {
  const pct = value === null ? 0 : Math.max(0, Math.min(1, value)) * 100;
  const bar: Record<Tone, string> = {
    neutral: "bg-slate-400",
    info: "bg-brand-500",
    success: "bg-emerald-500",
    warning: "bg-amber-500",
    critical: "bg-red-600",
    teal: "bg-teal-600",
    navy: "bg-navy-800",
  };
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
      <div className={cn("h-full rounded-full", bar[tone])} style={{ width: `${pct}%` }} />
    </div>
  );
}
