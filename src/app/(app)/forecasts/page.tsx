import type { Metadata } from "next";
import Link from "next/link";
import { ForecastChart, type SeriesPoint } from "@/components/charts/charts";
import { SnapshotButton } from "@/components/forms/misc-buttons";
import { FilterForm, FilterSelect, Table, Td, Th } from "@/components/ui/data";
import { Badge, Card, CardBody, CardHeader, DefinitionList, EmptyState, Notice, PageHeader } from "@/components/ui/primitives";
import { stockRiskTone } from "@/components/ui/tones";
import type { ForecastResult, Point } from "@/lib/analytics/forecast";
import { RISK_ORDER } from "@/lib/analytics/stock";
import { can } from "@/lib/auth/permissions";
import { withUser } from "@/lib/db";
import { addDays } from "@/lib/dates";
import { getSnapshots } from "@/lib/data/queries";
import { formatDateTime, formatDay, formatNumber, localName, type Locale, type TFunction, type TxFunction } from "@/lib/i18n";
import { getI18n } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "Forecasts" };

function toSeries(history: Point[], fc: ForecastResult, fromDate: string): SeriesPoint[] {
  const rows: SeriesPoint[] = history.filter((p) => p.date >= fromDate).map((p) => ({ date: p.date, actual: p.value }));
  if (rows.length && fc.forecast.length) rows[rows.length - 1].forecast = rows[rows.length - 1].actual;
  for (const f of fc.forecast) rows.push({ date: f.date, forecast: f.value, lower: f.lower, upper: f.upper });
  return rows;
}

function ForecastMeta({ fc, t, tx, locale }: { fc: ForecastResult; t: TFunction; tx: TxFunction; locale: Locale }) {
  const end = fc.start ? addDays(fc.start, fc.horizonDays - 1) : null;
  return (
    <div className="space-y-3">
      <DefinitionList
        items={[
          { label: t("forecasts.method"), value: t(`forecasts.methods.${fc.method}`) },
          { label: t("forecasts.period"), value: fc.start ? `${formatDay(fc.start, locale)} → ${formatDay(end, locale)}` : "—" },
          { label: t("forecasts.history"), value: formatNumber(fc.historyPoints) },
          {
            label: t("forecasts.sufficiency"),
            value: <Badge tone={fc.sufficiency === "sufficient" ? "success" : fc.sufficiency === "limited" ? "warning" : "critical"}>{t(`sufficiency.${fc.sufficiency}`)}</Badge>,
          },
          { label: t("forecasts.perDayMean"), value: fc.meanDaily === null ? "—" : `${formatNumber(fc.meanDaily)}${t("common.perDay")}` },
        ]}
      />
      <p className="text-[12px] text-ink-muted">{t(`forecasts.methodExplain.${fc.method}`)}</p>
      <div className="rounded-lg border border-line bg-slate-50/60 p-3">
        <p className="text-[13px] font-medium">{t("forecasts.backtest")}</p>
        {fc.backtest ? (
          <dl className="mt-2 grid grid-cols-2 gap-2 text-[13px] sm:grid-cols-4">
            <div>
              <dt className="text-[11px] text-ink-muted">{t("forecasts.mae")}</dt>
              <dd className="tabular font-semibold">{formatNumber(fc.backtest.mae)}</dd>
            </div>
            <div>
              <dt className="text-[11px] text-ink-muted">{t("forecasts.baselineMae")}</dt>
              <dd className="tabular font-semibold">{formatNumber(fc.backtest.baselineMae)}</dd>
            </div>
            <div>
              <dt className="text-[11px] text-ink-muted">{t("forecasts.improvement")}</dt>
              <dd className={`tabular font-semibold ${(fc.backtest.improvementPct ?? 0) > 0 ? "text-emerald-700" : "text-ink"}`}>
                {fc.backtest.improvementPct === null ? "—" : `${fc.backtest.improvementPct}%`}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] text-ink-muted">{t("forecasts.wape")}</dt>
              <dd className="tabular font-semibold">{fc.backtest.wape === null ? "—" : `${fc.backtest.wape}%`}</dd>
            </div>
          </dl>
        ) : (
          <p className="mt-1 text-[12px] text-ink-muted">{t("forecasts.noBacktest")}</p>
        )}
      </div>
      {fc.limitations.length > 0 && (
        <div>
          <p className="text-[13px] font-medium">{t("forecasts.limitations")}</p>
          <ul className="mt-1 space-y-0.5 text-[12px] text-ink-muted">
            {fc.limitations.map((l) => (
              <li key={l}>• {tx(l)}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default async function ForecastsPage({ searchParams }: PageProps<"/forecasts">) {
  const sp = (await searchParams) as Record<string, string | undefined>;
  const { t, tx, locale } = await getI18n();
  const { user, today, snaps } = await getSnapshots();
  if (!snaps.length) {
    return (
      <Card>
        <EmptyState title={t("empty.noAccess")} />
      </Card>
    );
  }
  const s = snaps.find((x) => x.facility.id === sp.facility) ?? [...snaps].sort((a, b) => b.risk.score - a.risk.score)[0];
  const meds = [...s.medicines].sort((a, b) => RISK_ORDER[a.assessment.risk] - RISK_ORDER[b.assessment.risk] || a.name.localeCompare(b.name));
  const m = meds.find((x) => x.medicineId === sp.medicine) ?? meds[0];
  const from = addDays(today, -56);
  const [last] = await withUser(user.id, (q) =>
    q.query<{ generated_at: string | null }>(`select max(generated_at) as generated_at from public.forecasts where facility_id = $1`, [s.facility.id]),
  );

  return (
    <>
      <PageHeader title={t("forecasts.title")} subtitle={t("forecasts.subtitle")} actions={can(user, "forecast:snapshot") && <SnapshotButton />} />
      <Notice tone="info" className="mb-4">
        {t("forecasts.disclaimer")} {last?.generated_at && <> · {t("forecasts.lastSnapshot")}: {formatDateTime(last.generated_at, locale)}</>}
      </Notice>
      <FilterForm applyLabel={t("common.apply")} resetHref="/forecasts" resetLabel={t("common.reset")}>
        <FilterSelect
          name="facility"
          label={t("forecasts.selectFacility")}
          value={s.facility.id}
          options={snaps.map((x) => ({ value: x.facility.id, label: localName(x.facility, locale) }))}
        />
        {m && (
          <FilterSelect
            name="medicine"
            label={t("forecasts.selectMedicine")}
            value={m.medicineId}
            options={meds.map((x) => ({ value: x.medicineId, label: localName(x, locale) }))}
          />
        )}
      </FilterForm>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title={t("forecasts.footfallTitle")} subtitle={localName(s.facility, locale)} />
          <CardBody className="space-y-4">
            <ForecastChart data={toSeries(s.footfall.series.filter((p) => p.date < today), s.footfall.forecast, from)} height={240} />
            <ForecastMeta fc={s.footfall.forecast} t={t} tx={tx} locale={locale} />
          </CardBody>
        </Card>
        {m && (
          <Card>
            <CardHeader title={t("forecasts.demandTitle")} subtitle={`${localName(m, locale)} · ${t(`units.${m.unit as "tablet"}`)}`} />
            <CardBody className="space-y-4">
              <ForecastChart data={toSeries(m.history, m.forecast, from)} height={240} unitLabel={t(`units.${m.unit as "tablet"}`)} />
              {m.censoredDays > 0 && <p className="text-[12px] text-ink-muted">{t("inventory.censored", { n: m.censoredDays })}</p>}
              <ForecastMeta fc={m.forecast} t={t} tx={tx} locale={locale} />
            </CardBody>
          </Card>
        )}
      </div>

      <Card className="mt-4">
        <CardHeader title={t("forecasts.stockoutTitle")} subtitle={localName(s.facility, locale)} />
        <Table>
          <thead>
            <tr>
              <Th>{t("inventory.colMedicine")}</Th>
              <Th align="right">{t("inventory.colUsable")}</Th>
              <Th align="right">{t("forecasts.perDayMean")}</Th>
              <Th align="right">{t("inventory.colDays")}</Th>
              <Th>{t("inventory.colStockout")}</Th>
              <Th>{t("forecasts.sufficiency")}</Th>
              <Th>{t("inventory.colRisk")}</Th>
            </tr>
          </thead>
          <tbody>
            {meds.map((x) => (
              <tr key={x.medicineId} className={x.medicineId === m?.medicineId ? "bg-brand-50/50" : ""}>
                <Td>
                  <Link href={`/forecasts?facility=${s.facility.id}&medicine=${x.medicineId}`} className="font-medium text-brand-700 hover:underline">
                    {localName(x, locale)}
                  </Link>
                </Td>
                <Td align="right">{formatNumber(x.assessment.usable)}</Td>
                <Td align="right">{x.forecast.meanDaily === null ? "—" : formatNumber(x.forecast.meanDaily)}</Td>
                <Td align="right">{x.assessment.daysRemaining === null ? "—" : formatNumber(x.assessment.daysRemaining)}</Td>
                <Td className="whitespace-nowrap text-[13px]">{formatDay(x.assessment.projectedStockoutDate, locale)}</Td>
                <Td className="text-[12px]">{t(`sufficiency.${x.forecast.sufficiency}`)}</Td>
                <Td>
                  <Badge tone={stockRiskTone[x.assessment.risk]}>{t(`stockRisk.${x.assessment.risk}`)}</Badge>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </>
  );
}
