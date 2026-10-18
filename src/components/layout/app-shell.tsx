"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";
import {
  Activity,
  ArrowLeftRight,
  BedDouble,
  Bell,
  Building2,
  ClipboardList,
  FileText,
  FlaskConical,
  Gauge,
  LayoutDashboard,
  LogOut,
  Menu,
  Package,
  Settings,
  Shuffle,
  TrendingUp,
  Users,
  X,
  HeartPulse,
  ListOrdered,
  CalendarClock,
  UserPlus,
  Truck,
  Stethoscope,
  MapPinCheck,
} from "lucide-react";
import { logoutAction, setLocaleAction } from "@/app/actions/auth";
import { useI18n } from "@/lib/i18n/client";
import type { AppUser } from "@/lib/auth/permissions";
import { cn } from "@/components/ui/primitives";
import type { IconName, NavSection } from "./nav-config";

const ICONS: Record<IconName, typeof Activity> = {
  dashboard: LayoutDashboard,
  facilities: Building2,
  inventory: Package,
  footfall: Activity,
  beds: BedDouble,
  attendance: Users,
  diagnostics: FlaskConical,
  alerts: Bell,
  forecasts: TrendingUp,
  risk: Gauge,
  redistribution: Shuffle,
  transfers: ArrowLeftRight,
  reports: FileText,
  audit: ClipboardList,
  admin: Settings,
  queue: ListOrdered,
  allocation: CalendarClock,
  register: UserPlus,
  distribution: Truck,
  workforce: Stethoscope,
  myAttendance: MapPinCheck,
};

function NavLinks({ sections, onNavigate, alertCount }: { sections: NavSection[]; onNavigate?: () => void; alertCount: number }) {
  const pathname = usePathname();
  const { t } = useI18n();
  return (
    <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4" aria-label="Main">
      {sections.map((section) => (
        <div key={section.label}>
          <p className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{t(section.label)}</p>
          <ul className="space-y-0.5">
            {section.items.map((item) => {
              const Icon = ICONS[item.icon];
              const active = pathname === item.href || (item.href !== "/dashboard" && pathname.startsWith(item.href + "/")) || pathname === item.href;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm transition-colors",
                      active ? "bg-white/12 font-medium text-white" : "text-slate-300 hover:bg-white/6 hover:text-white",
                    )}
                  >
                    <Icon className={cn("size-4 shrink-0", active ? "text-teal-100" : "text-slate-400")} aria-hidden />
                    <span className="truncate">{t(item.label)}</span>
                    {item.icon === "alerts" && alertCount > 0 && (
                      <span className="ml-auto rounded-full bg-red-500 px-1.5 text-[11px] font-semibold text-white">{alertCount}</span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export function LanguageSwitch() {
  const { locale, t } = useI18n();
  const router = useRouter();
  const [pending, start] = useTransition();
  const change = (l: "en" | "hi") =>
    start(async () => {
      await setLocaleAction(l);
      router.refresh();
    });
  return (
    <div role="group" aria-label={t("nav.language")} className="inline-flex rounded-lg bg-slate-100 p-0.5 text-[13px]" aria-busy={pending}>
      {(["en", "hi"] as const).map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => change(l)}
          aria-pressed={locale === l}
          lang={l}
          className={cn("rounded-md px-2.5 py-1 font-medium", locale === l ? "bg-white text-ink shadow-sm" : "text-ink-muted hover:text-ink")}
        >
          {l === "en" ? "English" : "हिंदी"}
        </button>
      ))}
    </div>
  );
}

export function AppShell({
  user,
  sections,
  alertCount,
  demoMode,
  children,
}: {
  user: AppUser;
  sections: NavSection[];
  alertCount: number;
  demoMode: boolean;
  children: ReactNode;
}) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const scope = user.facilityName
    ? locale === "hi" && user.facilityNameHi ? user.facilityNameHi : user.facilityName
    : user.districtName
      ? locale === "hi" && user.districtNameHi ? user.districtNameHi : user.districtName
      : t("nav.stateLevel");

  const sidebar = (onNavigate?: () => void) => (
    <div className="flex h-full flex-col bg-navy-900 text-white">
      <div className="flex items-center gap-2.5 border-b border-white/10 px-4 py-4">
        <span className="grid size-8 place-items-center rounded-lg bg-teal-600">
          <HeartPulse className="size-5" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{t("app.name")}</p>
          <p className="truncate text-[11px] text-slate-400">{scope}</p>
        </div>
      </div>
      <NavLinks sections={sections} onNavigate={onNavigate} alertCount={alertCount} />
      <div className="border-t border-white/10 p-3">
        <form action={logoutAction}>
          <button type="submit" className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-slate-300 hover:bg-white/6 hover:text-white">
            <LogOut className="size-4" aria-hidden />
            {t("nav.signOut")}
          </button>
        </form>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2">
        {t("app.skipToContent")}
      </a>
      <aside className="no-print sticky top-0 hidden h-screen w-60 shrink-0 lg:block">{sidebar()}</aside>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label={t("nav.openMenu")}>
          <button type="button" className="absolute inset-0 bg-navy-950/50" onClick={() => setOpen(false)} aria-label={t("nav.closeMenu")} />
          <div className="relative h-full w-64 max-w-[80%] shadow-xl">
            {sidebar(() => setOpen(false))}
            <button type="button" onClick={() => setOpen(false)} className="absolute right-2 top-3 rounded-md p-1.5 text-slate-300 hover:bg-white/10" aria-label={t("nav.closeMenu")}>
              <X className="size-5" aria-hidden />
            </button>
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {demoMode && (
          <div className="no-print bg-amber-100 px-4 py-1.5 text-center text-[12px] font-medium text-amber-900" role="note">
            {t("demo.banner")}
          </div>
        )}
        <header className="no-print sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-white/95 px-4 backdrop-blur sm:px-6">
          <button type="button" onClick={() => setOpen(true)} className="rounded-md p-1.5 text-ink-muted hover:bg-slate-100 lg:hidden" aria-label={t("nav.openMenu")} aria-expanded={open}>
            <Menu className="size-5" aria-hidden />
          </button>
          <div className="flex min-w-0 items-center gap-2 lg:hidden">
            <HeartPulse className="size-5 text-teal-600" aria-hidden />
            <span className="truncate text-sm font-semibold">{t("app.name")}</span>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <LanguageSwitch />
            <div className="hidden text-right sm:block">
              <p className="max-w-[220px] truncate text-[13px] font-medium text-ink">{user.fullName}</p>
              <p className="text-[11px] text-ink-muted">{t(`roles.${user.role}`)}</p>
            </div>
          </div>
        </header>
        <main id="main" className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-5 sm:px-6 sm:py-6">
          {children}
        </main>
      </div>
    </div>
  );
}
