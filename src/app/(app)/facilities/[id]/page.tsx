import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, MapPin } from "lucide-react";
import { RiskBadge } from "@/components/domain/blocks";
import { LinkTabs } from "@/components/ui/data";
import { Badge, Card, EmptyState, Notice } from "@/components/ui/primitives";
import { opStatusTone } from "@/components/ui/tones";
import { canWriteFacility } from "@/lib/auth/permissions";
import { getSnapshots } from "@/lib/data/queries";
import { localName } from "@/lib/i18n";
import { getI18n } from "@/lib/i18n/server";
import { AlertsTab, BedsTab, DiagnosticsTab, InventoryTab, OverviewTab, PatientsTab, StaffTab } from "./tabs";
import { LoansTab } from "./loans-tab";

export const metadata: Metadata = { title: "Health centre" };

const TABS = ["overview", "inventory", "loans", "patients", "beds", "staff", "diagnostics", "alerts"] as const;
type Tab = (typeof TABS)[number];

export default async function FacilityPage({ params, searchParams }: PageProps<"/facilities/[id]">) {
  const { id } = await params;
  const sp = (await searchParams) as Record<string, string | undefined>;
  const i18n = await getI18n();
  const { t, locale } = i18n;
  const { user, today, snaps } = await getSnapshots();
  const s = snaps.find((x) => x.facility.id === id);

  if (!s) {
    return (
      <Card>
        <EmptyState title={t("facility.notFound")} />
      </Card>
    );
  }
  const f = s.facility;
  const tab: Tab = TABS.includes(sp.tab as Tab) ? (sp.tab as Tab) : "overview";
  const canWrite = canWriteFacility(user, f.id);
  const ctx = { s, user, today, sp, canWrite, ...i18n };

  const tabLabels: Record<Tab, string> = {
    overview: t("facility.tabOverview"),
    inventory: t("facility.tabInventory"),
    loans: t("distribution.facilityTitle"),
    patients: t("facility.tabPatients"),
    beds: t("facility.tabBeds"),
    staff: t("facility.tabStaff"),
    diagnostics: t("facility.tabDiagnostics"),
    alerts: t("facility.tabAlerts"),
  };
  const counts: Partial<Record<Tab, number>> = {
    inventory: s.stockCounts.stock_out + s.stockCounts.critical,
    diagnostics: s.diagnostics.essentialUnavailable,
    alerts: s.alerts.critical,
    staff: s.attendance.daysWithoutDoctor.length ? 1 : 0,
  };

  return (
    <>
      {user.role !== "facility_staff" && (
        <Link href="/facilities" className="no-print mb-3 inline-flex items-center gap-1 text-[13px] text-ink-muted hover:text-ink">
          <ArrowLeft className="size-4" aria-hidden />
          {t("facilities.title")}
        </Link>
      )}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{localName(f, locale)}</h1>
            <Badge tone="navy">{t(`facilityType.${f.facility_type}Long`)}</Badge>
            <Badge tone={opStatusTone[f.operational_status]}>{t(`opStatus.${f.operational_status}`)}</Badge>
            {f.is_demo && <Badge tone="warning">{t("demo.badge")}</Badge>}
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-muted">
            <span className="font-mono">{f.code}</span>
            <span className="inline-flex items-center gap-1">
              <MapPin className="size-3.5" aria-hidden />
              {f.block}, {localName({ name: f.district_name, name_hi: f.district_name_hi }, locale)}
            </span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-ink-muted">{t("facility.riskScore")}</span>
          <RiskBadge risk={s.risk} t={t} />
        </div>
      </div>
      {!canWrite && tab !== "overview" && tab !== "alerts" && (
        <Notice tone="info" className="mb-4">
          {t("common.readOnlyNotice")}
        </Notice>
      )}

      <LinkTabs
        active={tab}
        tabs={TABS.map((k) => ({ key: k, label: tabLabels[k], href: `/facilities/${f.id}?tab=${k}`, count: counts[k] }))}
      />

      {tab === "overview" && <OverviewTab {...ctx} />}
      {tab === "inventory" && <InventoryTab {...ctx} />}
      {tab === "loans" && <LoansTab {...ctx} />}
      {tab === "patients" && <PatientsTab {...ctx} />}
      {tab === "beds" && <BedsTab {...ctx} />}
      {tab === "staff" && <StaffTab {...ctx} />}
      {tab === "diagnostics" && <DiagnosticsTab {...ctx} />}
      {tab === "alerts" && <AlertsTab {...ctx} />}
    </>
  );
}
