import type { Metadata } from "next";
import Link from "next/link";
import { Activity, BedDouble, Bell, Building2, FlaskConical, Package, ShieldAlert, Users } from "lucide-react";
import { ForecastChart, StockRiskChart, type SeriesPoint, type StockRiskRow } from "@/components/charts/charts";
import { ALERT_SELECT, AlertListCompact, RiskBadge, type AlertRow } from "@/components/domain/blocks";
import { FilterForm, FilterInput, FilterSelect, KpiCard, Table, Td, Th } from "@/components/ui/data";
import { Badge, ButtonLink, Card, CardBody, CardHeader, EmptyState, Notice, PageHeader } from "@/components/ui/primitives";
import { utilizationTone } from "@/components/ui/tones";
import { withUser } from "@/lib/db";
import { addDays, dateRange, diffDays, isValidDay } from "@/lib/dates";
import { getDistricts, getRecommendations, getSnapshots } from "@/lib/data/queries";
import { formatDateTime, formatNumber, formatPct, formatRelative, localName } from "@/lib/i18n";
import { getI18n } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage({ searchParams }: PageProps<"/dashboard">) {
  const sp = (await searchParams) as Record<string, string | undefined>;
  const { t, tx, locale, dict } = await getI18n();
  const { user, today, snaps } = await getSnapshots();
  const districts = await getDistricts();

  // ---- filters --------------------------------------------------------------
  const period = sp.period ?? "30";
  let from = addDays(today, -Number(["7", "30", "60"].includes(period) ? period : 30));
  let to = addDays(today, -1);
  if (period === "custom" && sp.from && sp.to && isValidDay(sp.from) && isValidDay(sp.to) && sp.from <= sp.to) {
    from = sp.from < addDays(today, -90) ? addDays(today, -90) : sp.from;
    to = sp.to > today ? today : sp.to;
  }
  const filtered = snaps.filter(
    (s) =>
      (!sp.district || s.facility.district_id === sp.district) &&
      (!sp.type || s.facility.facility_type === sp.type) &&
      (!sp.facility || s.facility.id === sp.facility),
  );

  // ---- KPIs (all derived from stored records) ----------------------------------
  const phc = filtered.filter((s) => s.facility.facility_type === "PHC").length;
  const chc = filtered.length - phc;
  const needIntervention = filtered.filter((s) => s.risk.band === "high" || s.alerts.critical > 0).length;
  const visits = filtered.reduce(
    (a, s) => a + s.footfall.series.filter((p) => p.date >= from && p.date <= to).reduce((x, p) => x + p.value, 0),
    0,
  );
  const beds = filtered.reduce(
    (a, s) => ({ total: a.total + s.beds.total, occ: a.occ + s.beds.occupied, oos: a.oos + s.beds.outOfService, avail: a.avail + s.beds.available }),
    { total: 0, occ: 0, oos: 0, avail: 0 },
  );
  const alerts = filtered.reduce((a, s) => ({ open: a.open + s.alerts.open, critical: a.critical + s.alerts.critical }), { open: 0, critical: 0 });
  const stock = filtered.reduce(
    (a, s) => ({ out: a.out + s.stockCounts.stock_out, crit: a.crit + s.stockCounts.critical, high: a.high + s.stockCounts.high }),
    { out: 0, crit: 0, high: 0 },
  );
  const att = filtered.reduce(
    (a, s) => ({
      present: a.present + s.attendance.doctorPresent,
      base: a.base + s.attendance.doctorShifts - s.attendance.doctorLeave,
      unverified: a.unverified + s.attendance.counts.unverified,
      incomplete: a.incomplete + s.attendance.counts.incomplete,
    }),
    { present: 0, base: 0, unverified: 0, incomplete: 0 },
  );
  const diag = filtered.reduce(
    (a, s) => ({ down: a.down + s.diagnostics.unavailable, essential: a.essential + s.diagnostics.essentialUnavailable }),
    { down: 0, essential: 0 },
  );

  // ---- charts -------------------------------------------------------------------
  const chartFrom = diffDays(from, to) > 60 ? addDays(to, -60) : from;
  const byDate = new Map<string, SeriesPoint>();
  for (const d of dateRange(chartFrom, to)) byDate.set(d, { date: d, actual: 0 });
  for (const s of filtered) {
    for (const p of s.footfall.series) {
      const row = byDate.get(p.date);
      if (row) row.actual = (row.actual ?? 0) + p.value;
    }
  }
  const lastActual = byDate.get(to);
  if (lastActual) {
    lastActual.forecast = lastActual.actual;
  }
  if (to >= addDays(today, -1)) {
    for (const s of filtered) {
      for (const f of s.footfall.forecast.forecast) {
        const row = byDate.get(f.date) ?? { date: f.date };
        row.forecast = (row.forecast ?? 0) + f.value;
        row.lower = (row.lower ?? 0) + f.lower;
        row.upper = (row.upper ?? 0) + f.upper;
        byDate.set(f.date, row);
      }
    }
  }
  const series = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).map((r) => ({
    ...r,
    forecast: r.forecast == null ? null : Math.round(r.forecast),
    lower: r.lower == null ? null : Math.round(r.lower),
    upper: r.upper == null ? null : Math.round(r.upper),
  }));

  const stockRows: StockRiskRow[] = [...filtered]
    .sort((a, b) => b.risk.score - a.risk.score)
    .map((s) => ({
      name: s.facility.code,
      stock_out: s.stockCounts.stock_out,
      critical: s.stockCounts.critical,
      high: s.stockCounts.high,
      low: s.stockCounts.low,
      ok: s.stockCounts.ok,
      other: s.stockCounts.no_consumption + s.stockCounts.insufficient_data,
    }));

  // ---- activity, alerts, recommendations --------------------------------------
  const ids = filtered.map((s) => s.facility.id);
  const [recentAlerts, activity] = await withUser(user.id, async (q) => [
    await q.query<AlertRow>(
      `${ALERT_SELECT} where a.status <> 'resolved' and a.facility_id = any($1::uuid[])
        order by case a.severity when 'critical' then 0 when 'warning' then 1 else 2 end, a.created_at desc limit 6`,
      [ids],
    ),
    user.role === "facility_staff"
      ? await q.query<{ id: string; action: string; created_at: string; actor: string | null; facility: string | null; details: Record<string, unknown> }>(
          `select t.id, 'inventory.' || t.txn_type as action, t.occurred_at as created_at, p.full_name as actor, h.name as facility,
                  jsonb_build_object('quantity', t.quantity, 'medicine', m.name) as details
             from public.inventory_transactions t
             join public.medicines m on m.id = t.medicine_id
             join public.health_centres h on h.id = t.facility_id
             left join public.profiles p on p.id = t.performed_by
            order by t.occurred_at desc limit 8`,
        )
      : await q.query<{ id: string; action: string; created_at: string; actor: string | null; facility: string | null; details: Record<string, unknown> }>(
          `select l.id::text, l.action, l.created_at, p.full_name as actor, h.name as facility, l.details
             from public.audit_logs l
             left join public.profiles p on p.id = l.actor_id
             left join public.health_centres h on h.id = l.facility_id
            where l.facility_id is null or l.facility_id = any($1::uuid[])
            order by l.created_at desc limit 8`,
          [ids],
        ),
  ]);
  const recs = user.role === "facility_staff" ? [] : (await getRecommendations()).filter((r) => ids.includes(r.recipient.facilityId)).slice(0, 4);

  const isStaff = user.role === "facility_staff";
  const periodLabel = period === "custom" ? `${from} → ${to}` : t(period === "7" ? "common.last7" : period === "60" ? "common.last60" : "common.last30");
  const coverage = att.base > 0 ? att.present / att.base : null;

  return (
    <>
      <PageHeader
        title={isStaff ? t("dashboard.staffTitle") : t("dashboard.title")}
        subtitle={t("dashboard.subtitle")}
        actions={<Badge tone="warning">{t("demo.badge")}</Badge>}
      />
      {sp.denied && <Notice tone="warning" className="mb-4">{t("common.deniedNotice")}</Notice>}

      {!isStaff && (
        <FilterForm applyLabel={t("common.apply")} resetHref="/dashboard" resetLabel={t("common.reset")}>
          {districts.length > 1 && (
            <FilterSelect
              name="district"
              label={t("dashboard.filterDistrict")}
              value={sp.district}
              options={[{ value: "", label: t("common.all") }, ...districts.map((d) => ({ value: d.id, label: localName(d, locale) }))]}
            />
          )}
          <FilterSelect
            name="type"
            label={t("dashboard.filterType")}
            value={sp.type}
            options={[
              { value: "", label: t("common.all") },
              { value: "PHC", label: t("facilityType.PHCLong") },
              { value: "CHC", label: t("facilityType.CHCLong") },
            ]}
          />
          <FilterSelect
            name="facility"
            label={t("dashboard.filterFacility")}
            value={sp.facility}
            options={[{ value: "", label: t("common.all") }, ...snaps.map((s) => ({ value: s.facility.id, label: localName(s.facility, locale) }))]}
          />
          <FilterSelect
            name="period"
            label={t("dashboard.filterPeriod")}
            value={period}
            options={[
              { value: "7", label: t("common.last7") },
              { value: "30", label: t("common.last30") },
              { value: "60", label: t("common.last60") },
              { value: "custom", label: t("common.custom") },
            ]}
          />
          {period === "custom" && (
            <>
              <FilterInput type="date" name="from" label={t("common.from")} value={sp.from ?? from} />
              <FilterInput type="date" name="to" label={t("common.to")} value={sp.to ?? to} />
            </>
          )}
        </FilterForm>
      )}

      {filtered.length === 0 ? (
        <Card>
          <EmptyState title={t("empty.title")} body={t("empty.noAccess")} />
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <KpiCard label={t("dashboard.kpiFacilities")} value={formatNumber(filtered.length)} sub={t("dashboard.kpiFacilitiesSub", { phc, chc })} icon={<Building2 className="size-5" aria-hidden />} tone="navy" href="/facilities" />
            <KpiCard label={t("dashboard.kpiIntervention")} value={formatNumber(needIntervention)} sub={t("dashboard.kpiInterventionSub")} icon={<ShieldAlert className="size-5" aria-hidden />} tone={needIntervention ? "critical" : "success"} href="/risk" />
            <KpiCard label={t("dashboard.kpiVisits")} value={formatNumber(visits)} sub={`${t("dashboard.kpiVisitsSub")} · ${periodLabel}`} icon={<Activity className="size-5" aria-hidden />} tone="info" href="/footfall" />
            <KpiCard label={t("dashboard.kpiBeds")} value={`${formatNumber(beds.avail)} / ${formatNumber(beds.total)}`} sub={t("dashboard.kpiBedsSub", { occupied: beds.occ, oos: beds.oos })} icon={<BedDouble className="size-5" aria-hidden />} tone={utilizationTone(beds.total - beds.oos > 0 ? beds.occ / (beds.total - beds.oos) : null)} href="/beds" />
            <KpiCard label={t("dashboard.kpiAlerts")} value={formatNumber(alerts.critical)} sub={t("dashboard.kpiAlertsSub", { open: alerts.open })} icon={<Bell className="size-5" aria-hidden />} tone={alerts.critical ? "critical" : "success"} href="/alerts?severity=critical" />
            <KpiCard label={t("dashboard.kpiStockRisk")} value={formatNumber(stock.out + stock.crit + stock.high)} sub={t("dashboard.kpiStockRiskSub", { out: stock.out, crit: stock.crit })} icon={<Package className="size-5" aria-hidden />} tone={stock.out + stock.crit ? "critical" : stock.high ? "warning" : "success"} href="/inventory?risk=at_risk" />
            <KpiCard label={t("dashboard.kpiAttendance")} value={formatPct(coverage)} sub={t("dashboard.kpiAttendanceSub", { unverified: att.unverified, incomplete: att.incomplete })} icon={<Users className="size-5" aria-hidden />} tone={coverage !== null && coverage < 0.8 ? "warning" : "success"} href="/attendance" />
            <KpiCard label={t("dashboard.kpiDiagnostics")} value={formatNumber(diag.down)} sub={t("dashboard.kpiDiagnosticsSub", { essential: diag.essential })} icon={<FlaskConical className="size-5" aria-hidden />} tone={diag.essential ? "warning" : "success"} href="/diagnostics" />
          </div>

          <div className="mt-4 grid gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader title={t("dashboard.footfallTrend")} subtitle={`${t("dashboard.footfallTrendSub")} · ${periodLabel}`} />
              <CardBody>
                <ForecastChart data={series} />
              </CardBody>
            </Card>
            <Card>
              <CardHeader title={t("dashboard.stockRiskChart")} subtitle={t("dashboard.stockRiskChartSub")} />
              <CardBody>
                <StockRiskChart data={stockRows} />
              </CardBody>
            </Card>
          </div>

          <Card className="mt-4">
            <CardHeader title={t("dashboard.comparison")} subtitle={t("dashboard.comparisonSub")} actions={!isStaff && <ButtonLink href="/risk" size="sm">{t("nav.risk")}</ButtonLink>} />
            <Table caption={t("dashboard.comparison")}>
              <thead>
                <tr>
                  <Th>{t("common.facility")}</Th>
                  <Th>{t("dashboard.colRisk")}</Th>
                  <Th align="right">{t("dashboard.colStock")}</Th>
                  <Th align="right">{t("dashboard.colBeds")}</Th>
                  <Th align="right">{t("dashboard.colStaff")}</Th>
                  <Th align="right">{t("dashboard.colDiagnostics")}</Th>
                  <Th align="right">{t("dashboard.colAlerts")}</Th>
                  <Th>{t("dashboard.colUpdated")}</Th>
                </tr>
              </thead>
              <tbody>
                {[...filtered]
                  .sort((a, b) => b.risk.score - a.risk.score)
                  .map((s) => {
                    const issues = s.stockCounts.stock_out + s.stockCounts.critical + s.stockCounts.high;
                    return (
                      <tr key={s.facility.id} className="hover:bg-slate-50/60">
                        <Td>
                          <Link href={`/facilities/${s.facility.id}`} className="font-medium text-brand-700 hover:underline">
                            {localName(s.facility, locale)}
                          </Link>
                          <span className="block text-[11px] text-ink-muted">
                            {s.facility.code} · {t(`facilityType.${s.facility.facility_type}`)}
                          </span>
                        </Td>
                        <Td>
                          <RiskBadge risk={s.risk} t={t} />
                        </Td>
                        <Td align="right">
                          {issues ? <Badge tone={s.stockCounts.stock_out + s.stockCounts.critical ? "critical" : "warning"}>{issues}</Badge> : <span className="text-ink-faint">0</span>}
                        </Td>
                        <Td align="right">
                          <Badge tone={utilizationTone(s.beds.utilization)}>
                            {s.beds.occupied}/{s.beds.total - s.beds.outOfService}
                          </Badge>
                        </Td>
                        <Td align="right">{formatPct(s.attendance.doctorCoverage)}</Td>
                        <Td align="right">{s.diagnostics.unavailable || <span className="text-ink-faint">0</span>}</Td>
                        <Td align="right">
                          {s.alerts.critical ? <Badge tone="critical">{s.alerts.open}</Badge> : s.alerts.open}
                        </Td>
                        <Td className="whitespace-nowrap text-[12px] text-ink-muted">
                          {formatRelative(s.facility.last_data_update, t)}
                          {(s.hoursSinceUpdate ?? 999) > 48 && <Badge tone="warning" className="ml-1">{t("facilities.stale")}</Badge>}
                        </Td>
                      </tr>
                    );
                  })}
              </tbody>
            </Table>
          </Card>

          <div className="mt-4 grid gap-4 xl:grid-cols-3">
            <Card className="xl:col-span-1">
              <CardHeader title={t("alerts.openAlerts")} actions={<ButtonLink href="/alerts" size="sm">{t("common.viewAll")}</ButtonLink>} />
              {recentAlerts.length ? <AlertListCompact alerts={recentAlerts} t={t} tx={tx} locale={locale} dict={dict} /> : <EmptyState title={t("alerts.empty")} />}
            </Card>
            <Card>
              <CardHeader title={t("dashboard.recommendations")} actions={!isStaff && <ButtonLink href="/redistribution" size="sm">{t("common.viewAll")}</ButtonLink>} />
              <CardBody className="space-y-3">
                {recs.length === 0 && <p className="text-sm text-ink-muted">{isStaff ? t("transfers.subtitle") : t("dashboard.noRecommendations")}</p>}
                {isStaff && <ButtonLink href="/transfers" variant="primary" size="sm">{t("transfers.newRequest")}</ButtonLink>}
                {recs.map((r) => (
                  <Link key={r.key} href="/redistribution" className="block rounded-lg border border-line p-3 hover:border-brand-200 hover:bg-brand-50/40">
                    <p className="text-[13px] font-medium">
                      {formatNumber(r.quantity)} {t(`units.${r.unit as "tablet"}`)} · {r.medicineName}
                    </p>
                    <p className="mt-0.5 text-[12px] text-ink-muted">
                      {r.donor.facilityName} → {r.recipient.facilityName}
                    </p>
                    <p className="mt-1 text-[12px] text-teal-700">
                      {t("redistribution.effectValue", { before: r.recipient.daysOfStockBefore, after: r.recipient.daysOfStockAfter })}
                    </p>
                  </Link>
                ))}
              </CardBody>
            </Card>
            <Card>
              <CardHeader title={t("dashboard.recentActivity")} actions={!isStaff && <ButtonLink href="/audit" size="sm">{t("common.viewAll")}</ButtonLink>} />
              <ul className="divide-y divide-line">
                {activity.map((a) => (
                  <li key={a.id} className="px-4 py-2 sm:px-5">
                    <p className="text-[13px]">
                      <span className="font-mono text-[12px] text-brand-700">{a.action}</span>
                      {a.facility && <span className="text-ink-muted"> · {a.facility}</span>}
                    </p>
                    <p className="text-[11px] text-ink-muted">
                      {a.actor ?? t("audit.system")} · {formatDateTime(a.created_at, locale)}
                    </p>
                  </li>
                ))}
                {activity.length === 0 && <EmptyState title={t("audit.empty")} />}
              </ul>
            </Card>
          </div>
        </>
      )}
    </>
  );
}
