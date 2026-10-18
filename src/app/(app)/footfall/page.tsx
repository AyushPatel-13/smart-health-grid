import type { Metadata } from "next";
import Link from "next/link";
import { ForecastChart, TotalsChart, type SeriesPoint } from "@/components/charts/charts";
import { FilterForm, FilterSelect, Table, Td, Th } from "@/components/ui/data";
import { Badge, Card, CardBody, CardHeader, EmptyState, Notice, PageHeader } from "@/components/ui/primitives";
import { addDays, dateRange, weekday } from "@/lib/dates";
import { getSnapshots } from "@/lib/data/queries";
import { formatDay, formatNumber, formatPct, formatShortDay, localName } from "@/lib/i18n";
import { getI18n } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "Patient footfall" };

export default async function FootfallPage({ searchParams }: PageProps<"/footfall">) {
  const sp = (await searchParams) as Record<string, string | undefined>;
  const { t, locale } = await getI18n();
  const { today, snaps } = await getSnapshots();
  const view = sp.view === "weekly" || sp.view === "monthly" ? sp.view : "daily";
  const filtered = snaps.filter((s) => (!sp.type || s.facility.facility_type === sp.type) && (!sp.facility || s.facility.id === sp.facility));

  // Aggregate daily series + summed forecast
  const from = addDays(today, -60);
  const yesterday = addDays(today, -1);
  const map = new Map<string, SeriesPoint>();
  for (const d of dateRange(from, yesterday)) map.set(d, { date: d, actual: 0 });
  for (const s of filtered) for (const p of s.footfall.series) if (map.has(p.date)) map.get(p.date)!.actual! += p.value;
  const lastRow = map.get(yesterday);
  if (lastRow) lastRow.forecast = lastRow.actual;
  for (const s of filtered)
    for (const f of s.footfall.forecast.forecast) {
      const r = map.get(f.date) ?? { date: f.date };
      r.forecast = (r.forecast ?? 0) + f.value;
      r.lower = (r.lower ?? 0) + f.lower;
      r.upper = (r.upper ?? 0) + f.upper;
      map.set(f.date, r);
    }
  const daily = [...map.values()].sort((a, b) => a.date.localeCompare(b.date)).map((r) => ({
    ...r,
    forecast: r.forecast == null ? null : Math.round(r.forecast),
    lower: r.lower == null ? null : Math.round(r.lower),
    upper: r.upper == null ? null : Math.round(r.upper),
  }));

  const buckets = new Map<string, number>();
  for (const s of filtered)
    for (const p of s.footfall.series) {
      const key = view === "weekly" ? addDays(p.date, -((weekday(p.date) + 6) % 7)) : p.date.slice(0, 7);
      buckets.set(key, (buckets.get(key) ?? 0) + p.value);
    }
  const totals = [...buckets.entries()]
    .sort()
    .slice(view === "weekly" ? -9 : -3)
    .map(([k, v]) => ({ label: view === "weekly" ? formatShortDay(k, locale) : formatDay(`${k}-01`, locale).replace(/^\d+\s/, ""), value: v }));

  const spikes = filtered.filter((s) => s.footfall.spike.isSpike);

  return (
    <>
      <PageHeader title={t("footfall.title")} subtitle={t("footfall.subtitle")} />
      <FilterForm applyLabel={t("common.apply")} resetHref="/footfall" resetLabel={t("common.reset")}>
        <FilterSelect
          name="view"
          label={t("common.period")}
          value={view}
          options={[
            { value: "daily", label: t("footfall.daily") },
            { value: "weekly", label: t("footfall.weekly") },
            { value: "monthly", label: t("footfall.monthly") },
          ]}
        />
        {snaps.length > 1 && (
          <>
            <FilterSelect
              name="type"
              label={t("common.type")}
              value={sp.type}
              options={[{ value: "", label: t("common.all") }, { value: "PHC", label: t("facilityType.PHCLong") }, { value: "CHC", label: t("facilityType.CHCLong") }]}
            />
            <FilterSelect
              name="facility"
              label={t("common.facility")}
              value={sp.facility}
              options={[{ value: "", label: t("common.all") }, ...snaps.map((s) => ({ value: s.facility.id, label: localName(s.facility, locale) }))]}
            />
          </>
        )}
      </FilterForm>

      {filtered.length === 0 ? (
        <Card>
          <EmptyState title={t("common.noData")} />
        </Card>
      ) : (
        <>
          <div className="grid gap-4 xl:grid-cols-3">
            <Card className="xl:col-span-2">
              <CardHeader title={view === "daily" ? t("dashboard.footfallTrend") : `${t(`footfall.${view}`)} · ${t("footfall.opd")}`} subtitle={view === "daily" ? t("dashboard.footfallTrendSub") : undefined} />
              <CardBody>{view === "daily" ? <ForecastChart data={daily} /> : <TotalsChart data={totals} name={t("footfall.opd")} height={260} />}</CardBody>
            </Card>
            <Card>
              <CardHeader title={t("footfall.spikes")} />
              <CardBody>
                {spikes.length === 0 ? (
                  <p className="text-sm text-ink-muted">{t("footfall.noSpikes")}</p>
                ) : (
                  <ul className="space-y-2">
                    {spikes.map((s) => (
                      <li key={s.facility.id}>
                        <Notice tone="warning">
                          <Link href={`/facilities/${s.facility.id}?tab=patients`} className="font-medium underline">
                            {localName(s.facility, locale)}
                          </Link>
                          <span className="block">
                            {formatDay(s.footfall.spike.latest?.date, locale)}: {formatNumber(s.footfall.spike.latest?.value)} vs ~{formatNumber(s.footfall.spike.baselineMean)} ({s.footfall.spike.ratio}×)
                          </span>
                        </Notice>
                      </li>
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>
          </div>

          <Card className="mt-4">
            <CardHeader title={t("footfall.comparison")} subtitle={t("footfall.workload")} />
            <Table>
              <thead>
                <tr>
                  <Th>{t("common.facility")}</Th>
                  <Th align="right">{t("footfall.total7")}</Th>
                  <Th align="right">{t("footfall.change")}</Th>
                  <Th align="right">{t("footfall.avgDaily")}</Th>
                  <Th align="right">{t("footfall.capacityPct")}</Th>
                  <Th align="right">{t("facility.projected")}</Th>
                  <Th>{t("footfall.latest")}</Th>
                </tr>
              </thead>
              <tbody>
                {[...filtered]
                  .sort((a, b) => b.footfall.last7Total / b.facility.opd_capacity_per_day - a.footfall.last7Total / a.facility.opd_capacity_per_day)
                  .map((s) => {
                    const avg = s.footfall.last7Total / 7;
                    const load = avg / s.facility.opd_capacity_per_day;
                    const change = s.footfall.prev7Total > 0 ? (s.footfall.last7Total - s.footfall.prev7Total) / s.footfall.prev7Total : null;
                    return (
                      <tr key={s.facility.id}>
                        <Td>
                          <Link href={`/facilities/${s.facility.id}?tab=patients`} className="font-medium text-brand-700 hover:underline">
                            {localName(s.facility, locale)}
                          </Link>
                          {s.footfall.spike.isSpike && (
                            <Badge tone="warning" className="ml-1.5">
                              {t("alerts.categories.footfall_spike")}
                            </Badge>
                          )}
                        </Td>
                        <Td align="right">{formatNumber(s.footfall.last7Total)}</Td>
                        <Td align="right" className={change !== null && change > 0.15 ? "text-amber-700" : ""}>
                          {change === null ? "—" : `${change > 0 ? "+" : ""}${Math.round(change * 100)}%`}
                        </Td>
                        <Td align="right">{formatNumber(Math.round(avg))}</Td>
                        <Td align="right">
                          <Badge tone={load >= 1 ? "critical" : load >= 0.9 ? "warning" : "success"}>{formatPct(load)}</Badge>
                        </Td>
                        <Td align="right">{s.footfall.forecast.meanDaily === null ? "—" : formatNumber(s.footfall.forecast.meanDaily)}</Td>
                        <Td className="whitespace-nowrap text-[12px]">
                          {formatDay(s.footfall.latest?.date, locale)}
                          {(s.footfall.daysSinceLastEntry ?? 99) > 2 && (
                            <Badge tone="warning" className="ml-1">
                              {t("facilities.stale")}
                            </Badge>
                          )}
                        </Td>
                      </tr>
                    );
                  })}
              </tbody>
            </Table>
          </Card>
        </>
      )}
    </>
  );
}
