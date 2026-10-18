import Link from "next/link";
import { ForecastChart, TotalsChart, type SeriesPoint } from "@/components/charts/charts";
import { ALERT_SELECT, AlertListCompact, ReasonList, RiskBreakdown, type AlertRow } from "@/components/domain/blocks";
import { InventoryForms } from "@/components/forms/inventory-forms";
import { AddShiftForm, AttendanceActions, BedWardButton, DiagnosticEditButton, FootfallForm } from "@/components/forms/operations-forms";
import { KpiCard, Pagination, Table, Td, Th } from "@/components/ui/data";
import { Badge, Card, CardBody, CardHeader, DefinitionList, EmptyState, Meter, Notice } from "@/components/ui/primitives";
import { attendanceTone, diagTone, stockRiskTone, utilizationTone } from "@/components/ui/tones";
import { classifyShift } from "@/lib/analytics/attendance";
import { RISK_ORDER } from "@/lib/analytics/stock";
import { can, type AppUser } from "@/lib/auth/permissions";
import { STOCK_RULES } from "@/lib/config/rules";
import type { FacilitySnapshot } from "@/lib/data/snapshot";
import { withUser } from "@/lib/db";
import { addDays, dateRange, isValidDay, weekday } from "@/lib/dates";
import { formatDateTime, formatDay, formatNumber, formatPct, formatRelative, formatShortDay, localName, type Locale, type TFunction, type TxFunction } from "@/lib/i18n";
import type { Dictionary } from "@/lib/i18n/en";

export interface TabCtx {
  s: FacilitySnapshot;
  user: AppUser;
  today: string;
  sp: Record<string, string | undefined>;
  canWrite: boolean;
  locale: Locale;
  dict: Dictionary;
  t: TFunction;
  tx: TxFunction;
}

function unitLabel(t: TFunction, unit: string) {
  return t(`units.${unit as "tablet"}`);
}

export function footfallSeries(s: FacilitySnapshot, from: string, to: string): SeriesPoint[] {
  const map = new Map<string, SeriesPoint>();
  for (const d of dateRange(from, to)) map.set(d, { date: d, actual: null });
  for (const p of s.footfall.series) if (map.has(p.date)) map.get(p.date)!.actual = p.value;
  const last = [...map.values()].reverse().find((r) => r.actual != null);
  if (last) last.forecast = last.actual;
  for (const f of s.footfall.forecast.forecast) map.set(f.date, { date: f.date, forecast: f.value, lower: f.lower, upper: f.upper });
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
export async function OverviewTab({ s, user, today, t, tx, locale, dict }: TabCtx) {
  const f = s.facility;
  const alerts = await withUser(user.id, (q) =>
    q.query<AlertRow>(
      `${ALERT_SELECT} where a.facility_id = $1 and a.status <> 'resolved'
        order by case a.severity when 'critical' then 0 when 'warning' then 1 else 2 end, a.created_at desc limit 6`,
      [f.id],
    ),
  );
  const atRisk = [...s.medicines]
    .filter((m) => ["stock_out", "critical", "high", "low"].includes(m.assessment.risk))
    .sort((a, b) => RISK_ORDER[a.assessment.risk] - RISK_ORDER[b.assessment.risk]);
  const fc = s.footfall.forecast;
  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <div className="space-y-4 xl:col-span-2">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <KpiCard label={t("facility.lastWeek")} value={formatNumber(s.footfall.last7Total)} sub={`${t("facility.prevWeek")}: ${formatNumber(s.footfall.prev7Total)}`} tone="info" />
          <KpiCard label={t("beds.available")} value={`${s.beds.available}/${s.beds.total}`} sub={`${t("beds.utilization")}: ${formatPct(s.beds.utilization)}`} tone={utilizationTone(s.beds.utilization)} />
          <KpiCard label={t("attendance.coverage")} value={formatPct(s.attendance.doctorCoverage)} sub={`${t("attendance.daysWithoutDoctor")}: ${s.attendance.daysWithoutDoctor.length}`} tone={s.attendance.daysWithoutDoctor.length ? "critical" : "success"} />
          <KpiCard label={t("diagnostics.essentialDown")} value={`${s.diagnostics.essentialUnavailable}/${s.diagnostics.essential}`} sub={`${t("diagnostics.stale")}: ${s.diagnostics.stale}`} tone={s.diagnostics.essentialUnavailable ? "warning" : "success"} />
        </div>
        <Card>
          <CardHeader
            title={t("facility.footfallSummary")}
            subtitle={`${t("forecasts.method")}: ${t(`forecasts.methods.${fc.method}`)} · ${t(`sufficiency.${fc.sufficiency}`)}`}
          />
          <CardBody>
            <ForecastChart data={footfallSeries(s, addDays(today, -30), addDays(today, -1))} height={220} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader
            title={t("facility.medicineSummary")}
            actions={
              <Link href={`/facilities/${f.id}?tab=inventory`} className="text-[13px] font-medium text-brand-700 hover:underline">
                {t("facility.tabInventory")} →
              </Link>
            }
          />
          <CardBody>
            <div className="mb-3 flex flex-wrap gap-1.5">
              {(Object.keys(s.stockCounts) as (keyof typeof s.stockCounts)[]).map((k) =>
                s.stockCounts[k] ? (
                  <Badge key={k} tone={stockRiskTone[k]}>
                    {t(`stockRisk.${k}`)}: {s.stockCounts[k]}
                  </Badge>
                ) : null,
              )}
            </div>
            {atRisk.length === 0 ? (
              <p className="text-sm text-ink-muted">{t("facility.noIssues")}</p>
            ) : (
              <ul className="divide-y divide-line">
                {atRisk.map((m) => (
                  <li key={m.medicineId} className="py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-[13px] font-medium">{localName(m, locale)}</span>
                      <Badge tone={stockRiskTone[m.assessment.risk]}>{t(`stockRisk.${m.assessment.risk}`)}</Badge>
                    </div>
                    <ReasonList reasons={m.assessment.reasons} tx={tx} className="mt-1" />
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>
      <div className="space-y-4">
        <Card>
          <CardHeader title={t("facility.riskExplain")} subtitle={`${t("facility.riskScore")}: ${s.risk.score}/100 · ${t(`riskBand.${s.risk.band}`)}`} />
          <CardBody>
            <RiskBreakdown risk={s.risk} t={t} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title={t("facility.keyIssues")} />
          {alerts.length ? <AlertListCompact alerts={alerts} t={t} tx={tx} locale={locale} dict={dict} showFacility={false} /> : <EmptyState title={t("facility.noIssues")} />}
        </Card>
        <Card>
          <CardHeader title={t("common.details")} />
          <CardBody>
            <DefinitionList
              className="sm:grid-cols-1"
              items={[
                { label: t("facility.capacity"), value: formatNumber(f.bed_capacity) },
                { label: t("facility.opdCapacity"), value: t("facility.perDayValue", { n: f.opd_capacity_per_day }) },
                { label: t("facility.block"), value: f.block ?? "—" },
                { label: t("facility.coordinates"), value: f.latitude != null ? `${f.latitude.toFixed(3)}, ${f.longitude?.toFixed(3)}` : "—" },
                { label: t("common.lastUpdated"), value: `${formatDateTime(f.last_data_update, locale)} (${formatRelative(f.last_data_update, t)})` },
              ]}
            />
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------
const TXN_PAGE = 20;

export async function InventoryTab({ s, user, today, sp, canWrite, t, tx, locale }: TabCtx) {
  const f = s.facility;
  const tp = Math.max(1, Number(sp.tp) || 1);
  const med = sp.med && s.medicines.some((m) => m.medicineId === sp.med) ? sp.med : null;
  const [batches, txns, [{ n: txnCount }]] = await withUser(user.id, async (q) => [
    await q.query<{
      id: string; medicine_id: string; name: string; name_hi: string | null; unit: string; batch_number: string;
      quantity_received: number; quantity_available: number; expiry_date: string; source: string; received_at: string;
    }>(
      `select b.id, b.medicine_id, m.name, m.name_hi, m.unit, b.batch_number, b.quantity_received, b.quantity_available,
              b.expiry_date, b.source, b.received_at
         from public.inventory_batches b join public.medicines m on m.id = b.medicine_id
        where b.facility_id = $1 and b.quantity_available > 0 and ($2::uuid is null or b.medicine_id = $2::uuid)
        order by m.name, b.expiry_date`,
      [f.id, med],
    ),
    await q.query<{
      id: string; txn_type: string; quantity: number; balance_after: number; reason: string | null; occurred_at: string;
      name: string; name_hi: string | null; batch_number: string; actor: string | null;
    }>(
      `select t.id, t.txn_type, t.quantity, t.balance_after, t.reason, t.occurred_at, m.name, m.name_hi, b.batch_number,
              p.full_name as actor
         from public.inventory_transactions t
         join public.medicines m on m.id = t.medicine_id
         join public.inventory_batches b on b.id = t.batch_id
         left join public.profiles p on p.id = t.performed_by
        where t.facility_id = $1 and ($2::uuid is null or t.medicine_id = $2::uuid)
        order by t.occurred_at desc, t.created_at desc
        limit ${TXN_PAGE} offset $3`,
      [f.id, med, (tp - 1) * TXN_PAGE],
    ),
    await q.query<{ n: number }>(
      `select count(*)::int as n from public.inventory_transactions where facility_id = $1 and ($2::uuid is null or medicine_id = $2::uuid)`,
      [f.id, med],
    ),
  ]);
  const nearCutoff = addDays(today, STOCK_RULES.nearExpiryDays);
  const meds = [...s.medicines].sort((a, b) => RISK_ORDER[a.assessment.risk] - RISK_ORDER[b.assessment.risk] || a.name.localeCompare(b.name));
  const base = `/facilities/${f.id}?tab=inventory${med ? `&med=${med}` : ""}`;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title={t("inventory.title")} subtitle={t("inventory.subtitle")} />
        <Table caption={t("inventory.title")}>
          <thead>
            <tr>
              <Th>{t("inventory.colMedicine")}</Th>
              <Th align="right">{t("inventory.colUsable")}</Th>
              <Th align="right">{t("inventory.colDemand")}</Th>
              <Th align="right">{t("inventory.colDays")}</Th>
              <Th>{t("inventory.colStockout")}</Th>
              <Th align="right">{t("inventory.colSafety")}</Th>
              <Th>{t("inventory.colNextDelivery")}</Th>
              <Th>{t("inventory.colRisk")}</Th>
            </tr>
          </thead>
          <tbody>
            {meds.map((m) => {
              const a = m.assessment;
              return (
                <tr key={m.medicineId} className={med === m.medicineId ? "bg-brand-50/50" : "hover:bg-slate-50/60"}>
                  <Td>
                    <Link href={`/facilities/${f.id}?tab=inventory&med=${m.medicineId}`} className="font-medium text-brand-700 hover:underline">
                      {localName(m, locale)}
                    </Link>
                    <span className="block text-[11px] text-ink-muted">
                      {m.code} · {unitLabel(t, m.unit)}
                      {m.isEssential && ` · ${t("common.essential")}`}
                    </span>
                  </Td>
                  <Td align="right">
                    <span className="font-semibold">{formatNumber(a.usable)}</span>
                    {a.expired > 0 && <span className="block text-[11px] text-red-700">{t("inventory.expired")}: {formatNumber(a.expired)}</span>}
                    {a.nearExpiry > 0 && <span className="block text-[11px] text-amber-700">{t("inventory.nearExpiry")}: {formatNumber(a.nearExpiry)}</span>}
                  </Td>
                  <Td align="right">
                    {a.dailyDemand === null ? <span className="text-[12px] text-ink-faint">{t("inventory.noForecast")}</span> : `${formatNumber(a.dailyDemand)}${t("common.perDay")}`}
                  </Td>
                  <Td align="right">{a.daysRemaining === null ? "—" : formatNumber(a.daysRemaining)}</Td>
                  <Td className="whitespace-nowrap text-[13px]">{a.projectedStockoutDate ? formatDay(a.projectedStockoutDate, locale) : "—"}</Td>
                  <Td align="right">
                    {formatNumber(m.safetyStock)}
                    <span className="block text-[11px] text-ink-muted">
                      {t("inventory.colLead")}: {t("inventory.daysValue", { n: m.leadTimeDays })}
                    </span>
                  </Td>
                  <Td className="text-[12px]">{a.nextDelivery ? t("inventory.deliveryValue", { qty: a.nextDelivery.quantity, date: formatDay(a.nextDelivery.expectedDate, locale) }) : "—"}</Td>
                  <Td className="min-w-[220px]">
                    <Badge tone={stockRiskTone[a.risk]}>{t(`stockRisk.${a.risk}`)}</Badge>
                    <ReasonList reasons={a.reasons} tx={tx} className="mt-1" />
                    {m.censoredDays > 0 && <p className="mt-0.5 text-[11px] text-ink-faint">{t("inventory.censored", { n: m.censoredDays })}</p>}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card>

      {canWrite && (
        <Card>
          <CardHeader title={t("inventory.detailTitle")} subtitle={t("inventory.issueHint")} />
          <CardBody>
            <InventoryForms
              facilityId={f.id}
              medicines={s.medicines.map((m) => ({ id: m.medicineId, name: localName(m, locale), unit: m.unit, usable: m.assessment.usable }))}
              batches={s.medicines.flatMap((m) =>
                m.batches.map((b) => ({
                  id: b.id,
                  medicineId: m.medicineId,
                  quantity: b.quantity,
                  expired: b.expiryDate < today,
                  label: `${localName(m, locale)} · ${b.batchNumber} · ${b.quantity} · ${b.expiryDate}${b.expiryDate < today ? ` (${t("inventory.expired")})` : ""}`,
                })),
              )}
            />
          </CardBody>
        </Card>
      )}

      <div className="grid gap-4 2xl:grid-cols-2">
        <Card>
          <CardHeader
            title={t("inventory.batches")}
            actions={med && <Link href={`/facilities/${f.id}?tab=inventory`} className="text-[13px] text-brand-700 hover:underline">{t("common.reset")}</Link>}
          />
          {batches.length === 0 ? (
            <EmptyState title={t("inventory.noBatches")} />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>{t("inventory.colMedicine")}</Th>
                  <Th>{t("inventory.batchNumber")}</Th>
                  <Th align="right">{t("inventory.available")}</Th>
                  <Th>{t("inventory.expiry")}</Th>
                  <Th>{t("inventory.source")}</Th>
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id}>
                    <Td className="text-[13px]">{localName(b, locale)}</Td>
                    <Td className="font-mono text-[12px]">{b.batch_number}</Td>
                    <Td align="right">
                      {formatNumber(b.quantity_available)}
                      <span className="block text-[11px] text-ink-muted">/ {formatNumber(b.quantity_received)}</span>
                    </Td>
                    <Td className="whitespace-nowrap text-[13px]">
                      {formatDay(b.expiry_date, locale)}{" "}
                      {b.expiry_date < today ? (
                        <Badge tone="critical">{t("inventory.expired")}</Badge>
                      ) : b.expiry_date <= nearCutoff ? (
                        <Badge tone="warning">{t("inventory.nearExpiry")}</Badge>
                      ) : null}
                    </Td>
                    <Td className="text-[12px]">{t(`inventory.sources.${b.source as "other"}`)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        <Card>
          <CardHeader title={t("inventory.history")} />
          {txns.length === 0 ? (
            <EmptyState title={t("inventory.noTransactions")} />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>{t("common.date")}</Th>
                  <Th>{t("common.type")}</Th>
                  <Th>{t("inventory.colMedicine")}</Th>
                  <Th align="right">{t("common.quantity")}</Th>
                  <Th align="right">{t("inventory.balanceAfter")}</Th>
                  <Th>{t("common.reason")}</Th>
                </tr>
              </thead>
              <tbody>
                {txns.map((x) => (
                  <tr key={x.id}>
                    <Td className="whitespace-nowrap text-[12px]">{formatDateTime(x.occurred_at, locale)}</Td>
                    <Td>
                      <Badge tone={x.quantity > 0 ? "success" : x.txn_type === "adjustment" || x.txn_type === "expiry_writeoff" ? "warning" : "neutral"}>
                        {t(`txnType.${x.txn_type as "issue"}`)}
                      </Badge>
                    </Td>
                    <Td className="text-[12px]">
                      {localName(x, locale)}
                      <span className="block font-mono text-[11px] text-ink-muted">{x.batch_number}</span>
                    </Td>
                    <Td align="right" className={x.quantity > 0 ? "text-emerald-700" : "text-ink"}>
                      {x.quantity > 0 ? "+" : ""}
                      {formatNumber(x.quantity)}
                    </Td>
                    <Td align="right">{formatNumber(x.balance_after)}</Td>
                    <Td className="text-[12px] text-ink-muted">
                      {x.reason ?? "—"}
                      <span className="block text-[11px]">{x.actor ?? ""}</span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          <Pagination
            page={tp}
            pageSize={TXN_PAGE}
            total={txnCount}
            makeHref={(p) => `${base}&tp=${p}`}
            labels={{
              showing: t("common.showing", { from: (tp - 1) * TXN_PAGE + 1, to: Math.min(txnCount, tp * TXN_PAGE), total: txnCount }),
              previous: t("common.previous"),
              next: t("common.next"),
            }}
          />
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Patients
// ---------------------------------------------------------------------------
export async function PatientsTab({ s, user, today, canWrite, t, locale }: TabCtx) {
  const f = s.facility;
  const recent = await withUser(user.id, (q) =>
    q.query<{
      id: string; stat_date: string; opd_visits: number; ipd_admissions: number; emergency_visits: number; revision: number;
      correction_reason: string | null; recorded_by_name: string | null; updated_at: string;
    }>(
      `select s.id, s.stat_date, s.opd_visits, s.ipd_admissions, s.emergency_visits, s.revision, s.correction_reason,
              p.full_name as recorded_by_name, s.updated_at
         from public.patient_daily_stats s left join public.profiles p on p.id = s.recorded_by
        where s.facility_id = $1 order by s.stat_date desc limit 14`,
      [f.id],
    ),
  );
  // Weekly totals (Mon-start ISO weeks) and calendar-month totals from stored rows.
  const weekly = new Map<string, number>();
  const monthly = new Map<string, number>();
  for (const p of s.footfall.series) {
    const wd = (weekday(p.date) + 6) % 7;
    const wk = addDays(p.date, -wd);
    weekly.set(wk, (weekly.get(wk) ?? 0) + p.value);
    const mo = p.date.slice(0, 7);
    monthly.set(mo, (monthly.get(mo) ?? 0) + p.value);
  }
  const weeks = [...weekly.entries()].sort().slice(-8).map(([d, v]) => ({ label: formatShortDay(d, locale), value: v }));
  const months = [...monthly.entries()].sort().slice(-3);
  const fc = s.footfall.forecast;
  const avg7 = s.footfall.last7Total / 7;

  return (
    <div className="space-y-4">
      <Notice tone="info">{t("footfall.subtitle")}</Notice>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label={t("facility.lastWeek")} value={formatNumber(s.footfall.last7Total)} sub={`${t("footfall.avgDaily")}: ${formatNumber(Math.round(avg7))}`} tone="info" />
        <KpiCard label={t("facility.prevWeek")} value={formatNumber(s.footfall.prev7Total)} />
        <KpiCard label={t("footfall.capacityPct")} value={formatPct(avg7 / f.opd_capacity_per_day)} sub={t("facility.perDayValue", { n: f.opd_capacity_per_day })} tone={avg7 / f.opd_capacity_per_day > 0.9 ? "warning" : "success"} />
        <KpiCard label={t("facility.projected")} value={fc.meanDaily === null ? "—" : `${formatNumber(fc.meanDaily)}${t("common.perDay")}`} sub={t(`sufficiency.${fc.sufficiency}`)} tone="teal" />
      </div>
      {s.footfall.spike.isSpike && (
        <Notice tone="warning">
          {t("alerts.templates.footfall_spike", { visits: s.footfall.spike.latest?.value ?? 0 })} — {t("footfall.avgDaily")} ~{formatNumber(s.footfall.spike.baselineMean)}
        </Notice>
      )}
      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title={t("footfall.title")} subtitle={`${t(`forecasts.methods.${fc.method}`)}${fc.backtest ? ` · ${t("forecasts.improvement")}: ${fc.backtest.improvementPct}%` : ""}`} />
          <CardBody>
            <ForecastChart data={footfallSeries(s, addDays(today, -60), addDays(today, -1))} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title={`${t("footfall.weekly")} / ${t("footfall.monthly")}`} />
          <CardBody>
            <TotalsChart data={weeks} name={t("footfall.opd")} height={180} />
            <ul className="mt-3 divide-y divide-line text-[13px]">
              {months.map(([m, v]) => (
                <li key={m} className="flex justify-between py-1.5">
                  <span>{formatDay(`${m}-01`, locale).replace(/^\d+\s/, "")}</span>
                  <span className="tabular font-medium">{formatNumber(v)}</span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      </div>
      {canWrite && (
        <Card>
          <CardHeader title={t("footfall.record")} />
          <CardBody>
            <FootfallForm facilityId={f.id} today={today} existingDates={s.footfall.series.map((p) => p.date)} />
          </CardBody>
        </Card>
      )}
      <Card>
        <CardHeader title={t("footfall.recent")} />
        <Table>
          <thead>
            <tr>
              <Th>{t("footfall.statDate")}</Th>
              <Th align="right">{t("footfall.opd")}</Th>
              <Th align="right">{t("footfall.ipd")}</Th>
              <Th align="right">{t("footfall.emergency")}</Th>
              <Th align="right">{t("footfall.revision")}</Th>
              <Th>{t("common.notes")}</Th>
            </tr>
          </thead>
          <tbody>
            {recent.map((r) => (
              <tr key={r.id}>
                <Td className="whitespace-nowrap">{formatDay(r.stat_date, locale)}</Td>
                <Td align="right" className="font-medium">{formatNumber(r.opd_visits)}</Td>
                <Td align="right">{formatNumber(r.ipd_admissions)}</Td>
                <Td align="right">{formatNumber(r.emergency_visits)}</Td>
                <Td align="right">{r.revision > 1 ? <Badge tone="warning">{r.revision}</Badge> : r.revision}</Td>
                <Td className="text-[12px] text-ink-muted">
                  {r.correction_reason ?? ""}
                  <span className="block text-[11px]">{r.recorded_by_name}</span>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Beds
// ---------------------------------------------------------------------------
export async function BedsTab({ s, canWrite, t, locale }: TabCtx) {
  const b = s.beds;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label={t("beds.total")} value={formatNumber(b.total)} sub={`${t("facility.capacity")}: ${s.facility.bed_capacity}`} />
        <KpiCard label={t("beds.occupied")} value={formatNumber(b.occupied)} sub={`${t("beds.utilization")}: ${formatPct(b.utilization)}`} tone={utilizationTone(b.utilization)} />
        <KpiCard label={t("beds.outOfService")} value={formatNumber(b.outOfService)} tone={b.outOfService ? "warning" : "neutral"} />
        <KpiCard label={t("beds.available")} value={formatNumber(b.available)} sub={`${t("beds.verifiedAt")}: ${formatDateTime(b.lastVerifiedAt, locale)}`} tone={b.available === 0 ? "critical" : "success"} />
      </div>
      <Card>
        <CardHeader title={t("beds.title")} subtitle={t("beds.subtitle")} actions={canWrite && <BedWardButton facilityId={s.facility.id} ward={null} />} />
        {b.wards.length === 0 ? (
          <EmptyState title={t("beds.noWards")} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>{t("beds.ward")}</Th>
                <Th align="right">{t("beds.total")}</Th>
                <Th align="right">{t("beds.occupied")}</Th>
                <Th align="right">{t("beds.outOfService")}</Th>
                <Th align="right">{t("beds.available")}</Th>
                <Th>{t("beds.utilization")}</Th>
                <Th>{t("beds.verifiedAt")}</Th>
                {canWrite && (
                  <Th>
                    <span className="sr-only">{t("common.actions")}</span>
                  </Th>
                )}
              </tr>
            </thead>
            <tbody>
              {b.wards.map((w) => {
                const op = w.total_beds - w.out_of_service_beds;
                const u = op > 0 ? w.occupied_beds / op : null;
                const stale = !!w.stale;
                return (
                  <tr key={w.id}>
                    <Td className="font-medium">{w.ward}</Td>
                    <Td align="right">{w.total_beds}</Td>
                    <Td align="right">{w.occupied_beds}</Td>
                    <Td align="right">{w.out_of_service_beds}</Td>
                    <Td align="right" className="font-semibold">{w.total_beds - w.occupied_beds - w.out_of_service_beds}</Td>
                    <Td className="min-w-[120px]">
                      <span className="tabular text-[12px]">{formatPct(u)}</span>
                      <Meter value={u} tone={utilizationTone(u)} label={t("beds.utilization")} />
                    </Td>
                    <Td className="whitespace-nowrap text-[12px]">
                      {formatDateTime(w.verified_at, locale)}
                      {stale && (
                        <Badge tone="warning" className="ml-1">
                          {t("facilities.stale")}
                        </Badge>
                      )}
                    </Td>
                    {canWrite && (
                      <Td align="right">
                        <BedWardButton facilityId={s.facility.id} ward={{ id: w.id, ward: w.ward, total_beds: w.total_beds, occupied_beds: w.occupied_beds, out_of_service_beds: w.out_of_service_beds }} />
                      </Td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Staff & attendance
// ---------------------------------------------------------------------------
export async function StaffTab({ s, user, today, sp, canWrite, t, tx, locale }: TabCtx) {
  const f = s.facility;
  const date = sp.date && isValidDay(sp.date) ? sp.date : today;
  const [shifts, staff] = await withUser(user.id, async (q) => [
    await q.query<{
      shift_id: string; shift_type: string; shift_date: string; staff_id: string; full_name: string; designation: string; is_doctor: boolean;
      attendance_id: string | null; status: "present" | "absent" | "approved_leave" | null; verification_status: "verified" | "unverified" | null;
      notes: string | null; recorded_by: string | null;
    }>(
      `select s.id as shift_id, s.shift_type, s.shift_date, st.id as staff_id, st.full_name, st.designation, st.is_doctor,
              a.id as attendance_id, a.status, a.verification_status, a.notes, p.full_name as recorded_by
         from public.shifts s
         join public.staff st on st.id = s.staff_id
         left join public.attendance a on a.shift_id = s.id
         left join public.profiles p on p.id = a.recorded_by
        where s.facility_id = $1 and s.shift_date = $2::date
        order by st.is_doctor desc, case s.shift_type when 'morning' then 0 when 'evening' then 1 when 'night' then 2 else 3 end, st.full_name`,
      [f.id, date],
    ),
    await q.query<{ id: string; full_name: string; designation: string; employee_code: string; is_doctor: boolean }>(
      `select id, full_name, designation, employee_code, is_doctor from public.staff where facility_id = $1 and is_active
        order by is_doctor desc, designation, full_name`,
      [f.id],
    ),
  ]);
  const a = s.attendance;
  const canVerify = can(user, "attendance:verify");
  const classes = ["present", "unverified", "approved_leave", "absent_verified", "incomplete", "pending"] as const;
  return (
    <div className="space-y-4">
      <Notice tone="info">{t("attendance.subtitle")}</Notice>
      <Card>
        <CardHeader title={t("attendance.summary")} subtitle={t("attendance.window")} />
        <CardBody>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {classes.map((c) => (
              <div key={c} className="rounded-lg border border-line p-3">
                <Badge tone={attendanceTone[c]}>{t(`attendanceClass.${c}`)}</Badge>
                <p className="tabular mt-2 text-xl font-semibold">{a.counts[c]}</p>
              </div>
            ))}
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <DefinitionList
              className="sm:grid-cols-1"
              items={[
                { label: t("attendance.coverage"), value: formatPct(a.doctorCoverage) },
                { label: t("attendance.daysWithoutDoctor"), value: a.daysWithoutDoctor.length ? a.daysWithoutDoctor.map((d) => formatShortDay(d, locale)).join(", ") : "0" },
              ]}
            />
            {a.needsReview && (
              <Notice tone="warning">
                <p className="font-medium">{t("attendance.needsReview")}</p>
                <ul className="mt-1 space-y-0.5">
                  {a.reviewReasons.map((r, i) => (
                    <li key={i}>• {tx(r.key, r.params)}</li>
                  ))}
                </ul>
              </Notice>
            )}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title={`${t("attendance.roster")} · ${formatDay(date, locale)}`}
          actions={
            <form method="get" className="flex items-end gap-2">
              <input type="hidden" name="tab" value="staff" />
              <label className="text-xs text-ink-muted">
                <span className="sr-only">{t("attendance.selectDate")}</span>
                <input type="date" name="date" defaultValue={date} className="h-8 rounded-lg border border-line px-2 text-sm" />
              </label>
              <button type="submit" className="h-8 rounded-lg bg-brand-600 px-3 text-[13px] font-medium text-white">
                {t("common.apply")}
              </button>
            </form>
          }
        />
        {shifts.length === 0 ? (
          <EmptyState title={t("attendance.noShifts")} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>{t("attendance.staffMember")}</Th>
                <Th>{t("attendance.shift")}</Th>
                <Th>{t("common.status")}</Th>
                {(canWrite || canVerify) && <Th align="right">{t("common.actions")}</Th>}
              </tr>
            </thead>
            <tbody>
              {shifts.map((r) => {
                const cls = classifyShift(
                  { shiftId: r.shift_id, staffId: r.staff_id, isDoctor: r.is_doctor, shiftDate: r.shift_date, shiftType: r.shift_type, status: r.status, verification: r.verification_status },
                  today,
                );
                return (
                  <tr key={r.shift_id}>
                    <Td>
                      <span className="font-medium">{r.full_name}</span>
                      <span className="block text-[11px] text-ink-muted">{t(`designation.${r.designation as "other"}`)}</span>
                    </Td>
                    <Td className="text-[13px]">{t(`shiftType.${r.shift_type as "morning"}`)}</Td>
                    <Td>
                      <Badge tone={attendanceTone[cls]}>{t(`attendanceClass.${cls}`)}</Badge>
                      {r.status && r.verification_status === "unverified" && r.status !== "approved_leave" && (
                        <span className="ml-1 text-[11px] text-ink-muted">({t(r.status === "present" ? "attendance.markPresent" : "attendance.markAbsent")})</span>
                      )}
                      {r.recorded_by && <span className="block text-[11px] text-ink-faint">{r.recorded_by}</span>}
                    </Td>
                    {(canWrite || canVerify) && (
                      <Td align="right">
                        <AttendanceActions
                          shiftId={r.shift_id}
                          attendanceId={r.attendance_id}
                          status={r.status}
                          verified={r.verification_status === "verified"}
                          canRecord={canWrite}
                          canVerify={canVerify}
                          isFuture={r.shift_date > today}
                        />
                      </Td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
        {canWrite && (
          <div className="border-t border-line px-4 py-4 sm:px-5">
            <AddShiftForm
              defaultDate={date}
              staff={staff.map((x) => ({ id: x.id, label: `${x.full_name} — ${t(`designation.${x.designation as "other"}`)}` }))}
            />
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title={t("attendance.staffList")} />
        <Table>
          <thead>
            <tr>
              <Th>{t("common.code")}</Th>
              <Th>{t("common.name")}</Th>
              <Th>{t("attendance.designation")}</Th>
            </tr>
          </thead>
          <tbody>
            {staff.map((x) => (
              <tr key={x.id}>
                <Td className="font-mono text-[12px]">{x.employee_code}</Td>
                <Td>{x.full_name}</Td>
                <Td>{t(`designation.${x.designation as "other"}`)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------
export async function DiagnosticsTab({ s, canWrite, t, locale }: TabCtx) {
  return (
    <Card>
      <CardHeader title={t("diagnostics.title")} subtitle={t("diagnostics.subtitle")} />
      <Table>
        <thead>
          <tr>
            <Th>{t("diagnostics.test")}</Th>
            <Th>{t("common.status")}</Th>
            <Th>{t("common.details")}</Th>
            <Th>{t("diagnostics.restoration")}</Th>
            <Th>{t("diagnostics.lastVerified")}</Th>
            {canWrite && (
              <Th>
                <span className="sr-only">{t("common.actions")}</span>
              </Th>
            )}
          </tr>
        </thead>
        <tbody>
          {s.diagnostics.services.map((d) => (
            <tr key={d.id}>
              <Td>
                <span className="font-medium">{localName(d, locale)}</span>
                <span className="block text-[11px] text-ink-muted">
                  {d.category}
                  {d.is_essential && ` · ${t("common.essential")}`}
                </span>
              </Td>
              <Td>
                <Badge tone={diagTone[d.status]}>{t(`diagStatus.${d.status}`)}</Badge>
              </Td>
              <Td className="max-w-xs text-[12px] text-ink-muted">
                {d.restriction_note && <p>{t("diagnostics.restriction")}: {d.restriction_note}</p>}
                {d.unavailability_reason && <p>{t("diagnostics.reasonUnavailable")}: {d.unavailability_reason}</p>}
                {d.equipment_issue && <p>{t("diagnostics.equipmentIssue")}: {d.equipment_issue}</p>}
                {d.required_supplies && <p>{t("diagnostics.requiredSupplies")}: {d.required_supplies}</p>}
                {d.status === "available" && "—"}
              </Td>
              <Td className="whitespace-nowrap text-[13px]">{formatDay(d.estimated_restoration_date, locale)}</Td>
              <Td className="whitespace-nowrap text-[12px]">
                {formatDateTime(d.last_verified_at, locale)}
                {d.stale && (
                  <Badge tone="warning" className="ml-1">
                    {t("diagnostics.stale")}
                  </Badge>
                )}
              </Td>
              {canWrite && (
                <Td align="right">
                  <DiagnosticEditButton
                    service={{
                      id: d.id,
                      name: localName(d, locale),
                      status: d.status,
                      restriction_note: d.restriction_note,
                      unavailability_reason: d.unavailability_reason,
                      equipment_issue: d.equipment_issue,
                      required_supplies: d.required_supplies,
                      estimated_restoration_date: d.estimated_restoration_date,
                    }}
                  />
                </Td>
              )}
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------
export async function AlertsTab({ s, user, t, tx, locale, dict }: TabCtx) {
  const alerts = await withUser(user.id, (q) =>
    q.query<AlertRow>(
      `${ALERT_SELECT} where a.facility_id = $1
        order by case a.status when 'open' then 0 when 'acknowledged' then 1 else 2 end,
                 case a.severity when 'critical' then 0 when 'warning' then 1 else 2 end, a.created_at desc limit 50`,
      [s.facility.id],
    ),
  );
  return (
    <Card>
      <CardHeader title={t("facility.tabAlerts")} />
      {alerts.length ? <AlertListCompact alerts={alerts} t={t} tx={tx} locale={locale} dict={dict} showFacility={false} /> : <EmptyState title={t("alerts.empty")} />}
    </Card>
  );
}
