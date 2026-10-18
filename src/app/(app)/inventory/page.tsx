import type { Metadata } from "next";
import Link from "next/link";
import { ReasonList } from "@/components/domain/blocks";
import { FilterForm, FilterInput, FilterSelect, Pagination, Table, Td, Th } from "@/components/ui/data";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui/primitives";
import { stockRiskTone } from "@/components/ui/tones";
import { RISK_ORDER, type StockRisk } from "@/lib/analytics/stock";
import { getSnapshots } from "@/lib/data/queries";
import { formatDay, formatNumber, localName } from "@/lib/i18n";
import { getI18n } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "Medicine inventory" };
const PAGE_SIZE = 25;
const RISKS: StockRisk[] = ["stock_out", "critical", "high", "low", "ok", "no_consumption", "insufficient_data"];

export default async function InventoryPage({ searchParams }: PageProps<"/inventory">) {
  const sp = (await searchParams) as Record<string, string | undefined>;
  const { t, tx, locale } = await getI18n();
  const { snaps } = await getSnapshots();
  const q = (sp.q ?? "").trim().toLowerCase();

  const rows = snaps
    .flatMap((s) => s.medicines.map((m) => ({ s, m })))
    .filter(({ s, m }) => {
      if (sp.facility && s.facility.id !== sp.facility) return false;
      if (sp.risk === "at_risk" && !["stock_out", "critical", "high"].includes(m.assessment.risk)) return false;
      if (sp.risk && sp.risk !== "at_risk" && m.assessment.risk !== sp.risk) return false;
      if (q && ![m.name, m.name_hi ?? "", m.code].some((v) => v.toLowerCase().includes(q))) return false;
      return true;
    })
    .sort(
      (a, b) =>
        RISK_ORDER[a.m.assessment.risk] - RISK_ORDER[b.m.assessment.risk] ||
        (a.m.assessment.daysUntilStockout ?? 9999) - (b.m.assessment.daysUntilStockout ?? 9999) ||
        a.m.name.localeCompare(b.m.name),
    );
  const page = Math.max(1, Number(sp.page) || 1);
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const qs = (p: number) =>
    `/inventory?${new URLSearchParams({ ...(Object.fromEntries(Object.entries(sp).filter(([, v]) => v)) as Record<string, string>), page: String(p) })}`;

  return (
    <>
      <PageHeader title={t("inventory.title")} subtitle={t("inventory.subtitle")} />
      <FilterForm applyLabel={t("common.apply")} resetHref="/inventory" resetLabel={t("common.reset")}>
        <FilterInput name="q" label={t("common.search")} value={sp.q} placeholder={t("inventory.searchPlaceholder")} />
        {snaps.length > 1 && (
          <FilterSelect
            name="facility"
            label={t("common.facility")}
            value={sp.facility}
            options={[{ value: "", label: t("inventory.allFacilities") }, ...snaps.map((s) => ({ value: s.facility.id, label: localName(s.facility, locale) }))]}
          />
        )}
        <FilterSelect
          name="risk"
          label={t("inventory.filterRisk")}
          value={sp.risk}
          options={[
            { value: "", label: t("common.all") },
            { value: "at_risk", label: `${t("stockRisk.stock_out")} + ${t("stockRisk.critical")} + ${t("stockRisk.high")}` },
            ...RISKS.map((r) => ({ value: r, label: t(`stockRisk.${r}`) })),
          ]}
        />
      </FilterForm>

      <Card>
        {pageRows.length === 0 ? (
          <EmptyState title={t("common.noData")} />
        ) : (
          <Table caption={t("inventory.title")}>
            <thead>
              <tr>
                <Th>{t("inventory.colMedicine")}</Th>
                <Th>{t("common.facility")}</Th>
                <Th align="right">{t("inventory.colUsable")}</Th>
                <Th align="right">{t("inventory.colDemand")}</Th>
                <Th align="right">{t("inventory.colDays")}</Th>
                <Th>{t("inventory.colStockout")}</Th>
                <Th align="right">{t("inventory.colExpired")}</Th>
                <Th>{t("inventory.colRisk")}</Th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map(({ s, m }) => {
                const a = m.assessment;
                return (
                  <tr key={`${s.facility.id}:${m.medicineId}`} className="hover:bg-slate-50/60">
                    <Td>
                      <Link href={`/facilities/${s.facility.id}?tab=inventory&med=${m.medicineId}`} className="font-medium text-brand-700 hover:underline">
                        {localName(m, locale)}
                      </Link>
                      <span className="block text-[11px] text-ink-muted">
                        {m.code} · {t(`units.${m.unit as "tablet"}`)}
                      </span>
                    </Td>
                    <Td className="text-[13px]">
                      {localName(s.facility, locale)}
                      <span className="block font-mono text-[11px] text-ink-muted">{s.facility.code}</span>
                    </Td>
                    <Td align="right" className="font-semibold">
                      {formatNumber(a.usable)}
                      <span className="block text-[11px] font-normal text-ink-muted">
                        {t("inventory.colSafety")}: {formatNumber(m.safetyStock)}
                      </span>
                    </Td>
                    <Td align="right">{a.dailyDemand === null ? <span className="text-[12px] text-ink-faint">{t("inventory.noForecast")}</span> : formatNumber(a.dailyDemand)}</Td>
                    <Td align="right">{a.daysRemaining === null ? "—" : formatNumber(a.daysRemaining)}</Td>
                    <Td className="whitespace-nowrap text-[13px]">{formatDay(a.projectedStockoutDate, locale)}</Td>
                    <Td align="right">{a.expired ? <span className="text-red-700">{formatNumber(a.expired)}</span> : "—"}</Td>
                    <Td className="min-w-[220px]">
                      <Badge tone={stockRiskTone[a.risk]}>{t(`stockRisk.${a.risk}`)}</Badge>
                      <ReasonList reasons={a.reasons.slice(0, 2)} tx={tx} className="mt-1" />
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
        <Pagination
          page={page}
          pageSize={PAGE_SIZE}
          total={rows.length}
          makeHref={qs}
          labels={{
            showing: t("common.showing", { from: (page - 1) * PAGE_SIZE + 1, to: Math.min(rows.length, page * PAGE_SIZE), total: rows.length }),
            previous: t("common.previous"),
            next: t("common.next"),
          }}
        />
      </Card>
    </>
  );
}
