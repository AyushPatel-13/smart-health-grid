import type { Metadata } from "next";
import { Download } from "lucide-react";
import { PrintButton } from "@/components/ui/print-button";
import { Table, Td, Th } from "@/components/ui/data";
import { Badge, Card, CardBody, CardHeader, Notice, PageHeader, buttonClass } from "@/components/ui/primitives";
import { riskBandTone } from "@/components/ui/tones";
import { getSnapshots } from "@/lib/data/queries";
import { formatDay, formatNumber, formatPct, localName } from "@/lib/i18n";
import { getI18n } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "Reports" };

export default async function ReportsPage() {
  const { t, locale } = await getI18n();
  const { today, snaps } = await getSnapshots();
  const exports = [
    { type: "facilities", label: t("reports.facilitySummary") },
    { type: "stock", label: t("reports.stockReport") },
    { type: "alerts", label: t("reports.alertsReport") },
    { type: "footfall", label: t("reports.footfallReport") },
  ];
  return (
    <>
      <PageHeader title={t("reports.title")} subtitle={t("reports.subtitle")} actions={<PrintButton label={t("common.print")} />} />
      <div className="no-print mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {exports.map((e) => (
          <Card key={e.type}>
            <CardBody className="flex h-full flex-col justify-between gap-3">
              <p className="text-sm font-medium">{e.label}</p>
              <a href={`/api/reports/${e.type}`} className={buttonClass("secondary", "sm")} download>
                <Download className="size-4" aria-hidden />
                {t("reports.download")}
              </a>
            </CardBody>
          </Card>
        ))}
      </div>
      <Notice tone="warning" className="mb-4">
        {t("demo.banner")}
      </Notice>
      <Card>
        <CardHeader title={t("reports.facilitySummary")} subtitle={t("reports.generated", { date: formatDay(today, locale) })} />
        <Table>
          <thead>
            <tr>
              <Th>{t("common.facility")}</Th>
              <Th>{t("risk.score")}</Th>
              <Th align="right">{t("facility.lastWeek")}</Th>
              <Th align="right">{t("beds.available")}</Th>
              <Th align="right">{t("dashboard.kpiStockRisk")}</Th>
              <Th align="right">{t("attendance.coverage")}</Th>
              <Th align="right">{t("dashboard.colDiagnostics")}</Th>
              <Th align="right">{t("alerts.openAlerts")}</Th>
            </tr>
          </thead>
          <tbody>
            {[...snaps]
              .sort((a, b) => b.risk.score - a.risk.score)
              .map((s) => (
                <tr key={s.facility.id}>
                  <Td>
                    <span className="font-medium">{localName(s.facility, locale)}</span>
                    <span className="block font-mono text-[11px] text-ink-muted">{s.facility.code}</span>
                  </Td>
                  <Td>
                    <Badge tone={riskBandTone[s.risk.band]}>
                      {s.risk.score} · {t(`riskBand.${s.risk.band}`)}
                    </Badge>
                  </Td>
                  <Td align="right">{formatNumber(s.footfall.last7Total)}</Td>
                  <Td align="right">
                    {s.beds.available}/{s.beds.total}
                  </Td>
                  <Td align="right">{s.stockCounts.stock_out + s.stockCounts.critical + s.stockCounts.high}</Td>
                  <Td align="right">{formatPct(s.attendance.doctorCoverage)}</Td>
                  <Td align="right">{s.diagnostics.unavailable}</Td>
                  <Td align="right">{s.alerts.open}</Td>
                </tr>
              ))}
          </tbody>
        </Table>
      </Card>
    </>
  );
}
