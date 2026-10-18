import type { Metadata } from "next";
import Link from "next/link";
import { KpiCard, Table, Td, Th } from "@/components/ui/data";
import { Badge, Card, CardHeader, EmptyState, PageHeader } from "@/components/ui/primitives";
import { diagTone } from "@/components/ui/tones";
import { getSnapshots } from "@/lib/data/queries";
import { formatDateTime, formatDay, formatNumber, localName } from "@/lib/i18n";
import { getI18n } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "Diagnostics" };

export default async function DiagnosticsPage() {
  const { t, locale } = await getI18n();
  const { snaps } = await getSnapshots();
  const tests = new Map<string, { id: string; code: string; name: string; name_hi: string | null; is_essential: boolean }>();
  for (const s of snaps) for (const d of s.diagnostics.services) tests.set(d.test_id, { id: d.test_id, code: d.code, name: d.name, name_hi: d.name_hi, is_essential: d.is_essential });
  const testList = [...tests.values()].sort((a, b) => Number(b.is_essential) - Number(a.is_essential) || a.name.localeCompare(b.name));
  const interrupted = snaps.flatMap((s) => s.diagnostics.services.filter((d) => d.status !== "available").map((d) => ({ s, d })));
  const stale = snaps.reduce((a, s) => a + s.diagnostics.stale, 0);
  const essentialDown = snaps.reduce((a, s) => a + s.diagnostics.essentialUnavailable, 0);

  return (
    <>
      <PageHeader title={t("diagnostics.title")} subtitle={t("diagnostics.subtitle")} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label={t("diagStatus.unavailable")} value={formatNumber(interrupted.filter((x) => x.d.status === "unavailable").length)} tone="critical" />
        <KpiCard label={t("diagStatus.limited")} value={formatNumber(interrupted.filter((x) => x.d.status === "limited").length)} tone="warning" />
        <KpiCard label={t("diagnostics.essentialDown")} value={formatNumber(essentialDown)} tone={essentialDown ? "critical" : "success"} />
        <KpiCard label={t("diagnostics.stale")} value={formatNumber(stale)} tone={stale ? "warning" : "neutral"} />
      </div>

      <Card className="mt-4">
        <CardHeader title={t("diagnostics.essentialDown")} />
        {interrupted.length === 0 ? (
          <EmptyState title={t("facilities.diagnosticsOk")} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>{t("common.facility")}</Th>
                <Th>{t("diagnostics.test")}</Th>
                <Th>{t("common.status")}</Th>
                <Th>{t("common.details")}</Th>
                <Th>{t("diagnostics.restoration")}</Th>
                <Th>{t("diagnostics.lastVerified")}</Th>
              </tr>
            </thead>
            <tbody>
              {interrupted.map(({ s, d }) => (
                <tr key={d.id}>
                  <Td>
                    <Link href={`/facilities/${s.facility.id}?tab=diagnostics`} className="font-medium text-brand-700 hover:underline">
                      {localName(s.facility, locale)}
                    </Link>
                  </Td>
                  <Td>
                    {localName(d, locale)}
                    {d.is_essential && <span className="block text-[11px] text-ink-muted">{t("common.essential")}</span>}
                  </Td>
                  <Td>
                    <Badge tone={diagTone[d.status]}>{t(`diagStatus.${d.status}`)}</Badge>
                  </Td>
                  <Td className="max-w-sm text-[12px] text-ink-muted">
                    {[d.unavailability_reason, d.restriction_note, d.equipment_issue, d.required_supplies].filter(Boolean).join(" · ")}
                  </Td>
                  <Td className="whitespace-nowrap text-[13px]">{formatDay(d.estimated_restoration_date, locale)}</Td>
                  <Td className="whitespace-nowrap text-[12px]">{formatDateTime(d.last_verified_at, locale)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card className="mt-4">
        <CardHeader title={t("diagnostics.matrix")} />
        <Table>
          <thead>
            <tr>
              <Th>{t("common.facility")}</Th>
              {testList.map((x) => (
                <Th key={x.id} align="center" className="normal-case">
                  <span className="block max-w-[90px] whitespace-normal text-[11px] leading-tight">{localName(x, locale)}</span>
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {snaps.map((s) => (
              <tr key={s.facility.id}>
                <Td className="whitespace-nowrap font-medium">{localName(s.facility, locale)}</Td>
                {testList.map((x) => {
                  const d = s.diagnostics.services.find((y) => y.test_id === x.id);
                  return (
                    <Td key={x.id} align="center">
                      {d ? (
                        <span title={`${t(`diagStatus.${d.status}`)}${d.stale ? ` · ${t("diagnostics.stale")}` : ""}`}>
                          <Badge tone={diagTone[d.status]} className={d.stale ? "ring-2 ring-amber-300" : ""}>
                            {d.status === "available" ? "✓" : d.status === "limited" ? "!" : "✕"}
                            <span className="sr-only">{t(`diagStatus.${d.status}`)}</span>
                          </Badge>
                        </span>
                      ) : (
                        <span className="text-ink-faint">·</span>
                      )}
                    </Td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </Table>
        <p className="px-5 py-3 text-[12px] text-ink-muted">
          ✓ {t("diagStatus.available")} · ! {t("diagStatus.limited")} · ✕ {t("diagStatus.unavailable")} · {t("diagnostics.staleLegend")}
        </p>
      </Card>
    </>
  );
}
