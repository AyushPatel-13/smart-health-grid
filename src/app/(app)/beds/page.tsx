import type { Metadata } from "next";
import Link from "next/link";
import { KpiCard, Table, Td, Th } from "@/components/ui/data";
import { Badge, Card, CardHeader, EmptyState, Meter, PageHeader } from "@/components/ui/primitives";
import { utilizationTone } from "@/components/ui/tones";
import { getSnapshots } from "@/lib/data/queries";
import { formatDateTime, formatNumber, formatPct, localName } from "@/lib/i18n";
import { getI18n } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "Beds" };

export default async function BedsPage() {
  const { t, locale } = await getI18n();
  const { snaps } = await getSnapshots();
  const tot = snaps.reduce(
    (a, s) => ({ total: a.total + s.beds.total, occ: a.occ + s.beds.occupied, oos: a.oos + s.beds.outOfService, avail: a.avail + s.beds.available }),
    { total: 0, occ: 0, oos: 0, avail: 0 },
  );
  const util = tot.total - tot.oos > 0 ? tot.occ / (tot.total - tot.oos) : null;
  const rows = [...snaps].sort((a, b) => (b.beds.utilization ?? 0) - (a.beds.utilization ?? 0));
  return (
    <>
      <PageHeader title={t("beds.title")} subtitle={t("beds.subtitle")} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label={t("beds.total")} value={formatNumber(tot.total)} />
        <KpiCard label={t("beds.occupied")} value={formatNumber(tot.occ)} sub={`${t("beds.utilization")}: ${formatPct(util)}`} tone={utilizationTone(util)} />
        <KpiCard label={t("beds.outOfService")} value={formatNumber(tot.oos)} tone={tot.oos ? "warning" : "neutral"} />
        <KpiCard label={t("beds.available")} value={formatNumber(tot.avail)} tone="success" />
      </div>
      <Card className="mt-4">
        <CardHeader title={t("beds.title")} />
        {rows.length === 0 ? (
          <EmptyState title={t("common.noData")} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>{t("common.facility")}</Th>
                <Th>{t("beds.ward")}</Th>
                <Th align="right">{t("beds.total")}</Th>
                <Th align="right">{t("beds.occupied")}</Th>
                <Th align="right">{t("beds.outOfService")}</Th>
                <Th align="right">{t("beds.available")}</Th>
                <Th>{t("beds.utilization")}</Th>
                <Th>{t("beds.verifiedAt")}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const stale = s.beds.stale;
                return (
                  <tr key={s.facility.id}>
                    <Td>
                      <Link href={`/facilities/${s.facility.id}?tab=beds`} className="font-medium text-brand-700 hover:underline">
                        {localName(s.facility, locale)}
                      </Link>
                      <span className="block font-mono text-[11px] text-ink-muted">{s.facility.code}</span>
                    </Td>
                    <Td className="text-[12px] text-ink-muted">
                      {s.beds.wards.map((w) => (
                        <span key={w.id} className="block whitespace-nowrap">
                          {w.ward}: {w.occupied_beds}/{w.total_beds - w.out_of_service_beds}
                          {w.occupied_beds >= w.total_beds - w.out_of_service_beds && w.total_beds - w.out_of_service_beds > 0 && (
                            <Badge tone="critical" className="ml-1 px-1.5 py-0 text-[10px]">
                              {t("beds.available")}: 0
                            </Badge>
                          )}
                        </span>
                      ))}
                    </Td>
                    <Td align="right">{s.beds.total}</Td>
                    <Td align="right">{s.beds.occupied}</Td>
                    <Td align="right">{s.beds.outOfService}</Td>
                    <Td align="right" className="font-semibold">{s.beds.available}</Td>
                    <Td className="min-w-[120px]">
                      <span className="tabular text-[12px]">{formatPct(s.beds.utilization)}</span>
                      <Meter value={s.beds.utilization} tone={utilizationTone(s.beds.utilization)} label={t("beds.utilization")} />
                    </Td>
                    <Td className="whitespace-nowrap text-[12px]">
                      {formatDateTime(s.beds.lastVerifiedAt, locale)}
                      {stale && (
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
        )}
      </Card>
    </>
  );
}
