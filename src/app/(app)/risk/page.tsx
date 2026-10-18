import type { Metadata } from "next";
import Link from "next/link";
import { RiskBadge, RiskBreakdown } from "@/components/domain/blocks";
import { Table, Td, Th } from "@/components/ui/data";
import { Card, CardBody, CardHeader, EmptyState, PageHeader } from "@/components/ui/primitives";
import { requireRole } from "@/lib/auth/user";
import { RISK_BANDS, RISK_WEIGHTS } from "@/lib/config/rules";
import { getSnapshots } from "@/lib/data/queries";
import { formatNumber, localName } from "@/lib/i18n";
import { getI18n } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "Risk ranking" };

export default async function RiskPage() {
  await requireRole("district_admin", "read_only");
  const { t, locale } = await getI18n();
  const { snaps } = await getSnapshots();
  const ranked = [...snaps].sort((a, b) => b.risk.score - a.risk.score);
  const factorKeys = Object.keys(RISK_WEIGHTS) as (keyof typeof RISK_WEIGHTS)[];

  return (
    <>
      <PageHeader title={t("risk.title")} subtitle={t("risk.subtitle")} />
      <Card className="mb-4">
        <CardHeader title={t("risk.method")} />
        <CardBody>
          <p className="text-[13px] text-ink-muted">{t("risk.methodBody", { high: RISK_BANDS.high, medium: RISK_BANDS.medium })}</p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[560px] text-[13px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-ink-muted">
                  <th className="py-1 pr-3 font-semibold">{t("risk.factor")}</th>
                  <th className="py-1 pr-3 text-right font-semibold">{t("risk.weight")}</th>
                  <th className="py-1 font-semibold">{t("risk.normalized")}</th>
                </tr>
              </thead>
              <tbody>
                {factorKeys.map((k) => (
                  <tr key={k} className="border-t border-line">
                    <td className="py-1.5 pr-3">{t(`risk.factors.${k}`)}</td>
                    <td className="tabular py-1.5 pr-3 text-right">{RISK_WEIGHTS[k]}</td>
                    <td className="py-1.5 font-mono text-[12px] text-ink-muted">{t(`risk.formulas.${k}`)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>

      <Card>
        {ranked.length === 0 ? (
          <EmptyState title={t("common.noData")} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>{t("risk.rank")}</Th>
                <Th>{t("common.facility")}</Th>
                <Th>{t("risk.score")}</Th>
                {factorKeys.map((k) => (
                  <Th key={k} align="right" className="normal-case">
                    <span className="block max-w-[90px] whitespace-normal leading-tight">{t(`risk.factors.${k}`)}</span>
                  </Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ranked.map((s, i) => (
                <tr key={s.facility.id} className="align-top">
                  <Td className="tabular font-semibold">{i + 1}</Td>
                  <Td className="min-w-[260px]">
                    <Link href={`/facilities/${s.facility.id}`} className="font-medium text-brand-700 hover:underline">
                      {localName(s.facility, locale)}
                    </Link>
                    <details className="mt-1">
                      <summary className="cursor-pointer text-[12px] text-ink-muted hover:text-ink">{t("facility.riskExplain")}</summary>
                      <div className="mt-2 rounded-lg border border-line p-3">
                        <RiskBreakdown risk={s.risk} t={t} />
                      </div>
                    </details>
                  </Td>
                  <Td>
                    <RiskBadge risk={s.risk} t={t} />
                  </Td>
                  {factorKeys.map((k) => {
                    const f = s.risk.factors.find((x) => x.key === k)!;
                    return (
                      <Td key={k} align="right" className={f.contribution >= RISK_WEIGHTS[k] * 0.66 ? "font-semibold text-red-700" : ""}>
                        {f.normalized === null ? <span className="text-[11px] text-ink-faint">{t("risk.missing")}</span> : formatNumber(f.contribution)}
                      </Td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
