import type { Metadata } from "next";
import Link from "next/link";
import { RiskBadge } from "@/components/domain/blocks";
import { FilterForm, FilterInput, FilterSelect, Pagination, Table, Td, Th } from "@/components/ui/data";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui/primitives";
import { opStatusTone, utilizationTone } from "@/components/ui/tones";
import { getDistricts, getSnapshots } from "@/lib/data/queries";
import { formatNumber, formatRelative, localName } from "@/lib/i18n";
import { getI18n } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "Health centres" };
const PAGE_SIZE = 20;

export default async function FacilitiesPage({ searchParams }: PageProps<"/facilities">) {
  const sp = (await searchParams) as Record<string, string | undefined>;
  const { t, locale } = await getI18n();
  const { snaps } = await getSnapshots();
  const districts = await getDistricts();
  const q = (sp.q ?? "").trim().toLowerCase();

  const rows = snaps.filter((s) => {
    const f = s.facility;
    if (sp.district && f.district_id !== sp.district) return false;
    if (sp.type && f.facility_type !== sp.type) return false;
    if (sp.status && f.operational_status !== sp.status) return false;
    if (sp.band && s.risk.band !== sp.band) return false;
    if (q && ![f.name, f.name_hi ?? "", f.code, f.block ?? "", f.district_name].some((v) => v.toLowerCase().includes(q))) return false;
    return true;
  });
  const page = Math.max(1, Number(sp.page) || 1);
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const makeHref = (p: number) => `/facilities?${new URLSearchParams({ ...Object.fromEntries(Object.entries(sp).filter(([, v]) => v)), page: String(p) } as Record<string, string>)}`;

  return (
    <>
      <PageHeader title={t("facilities.title")} subtitle={t("facilities.subtitle")} />
      <FilterForm applyLabel={t("common.apply")} resetHref="/facilities" resetLabel={t("common.reset")}>
        <FilterInput name="q" label={t("common.search")} value={sp.q} placeholder={t("facilities.searchPlaceholder")} />
        {districts.length > 1 && (
          <FilterSelect
            name="district"
            label={t("common.district")}
            value={sp.district}
            options={[{ value: "", label: t("common.all") }, ...districts.map((d) => ({ value: d.id, label: localName(d, locale) }))]}
          />
        )}
        <FilterSelect
          name="type"
          label={t("common.type")}
          value={sp.type}
          options={[{ value: "", label: t("common.all") }, { value: "PHC", label: t("facilityType.PHCLong") }, { value: "CHC", label: t("facilityType.CHCLong") }]}
        />
        <FilterSelect
          name="status"
          label={t("facilities.filterStatus")}
          value={sp.status}
          options={[
            { value: "", label: t("common.all") },
            { value: "operational", label: t("opStatus.operational") },
            { value: "limited", label: t("opStatus.limited") },
            { value: "non_operational", label: t("opStatus.non_operational") },
          ]}
        />
        <FilterSelect
          name="band"
          label={t("facilities.filterRisk")}
          value={sp.band}
          options={[
            { value: "", label: t("common.all") },
            { value: "high", label: t("riskBand.high") },
            { value: "medium", label: t("riskBand.medium") },
            { value: "low", label: t("riskBand.low") },
          ]}
        />
      </FilterForm>

      <Card>
        {pageRows.length === 0 ? (
          <EmptyState title={t("facilities.empty")} />
        ) : (
          <Table caption={t("facilities.title")}>
            <thead>
              <tr>
                <Th>{t("facilities.colName")}</Th>
                <Th>{t("facilities.colLocation")}</Th>
                <Th>{t("common.status")}</Th>
                <Th align="right">{t("facilities.colCapacity")}</Th>
                <Th>{t("facilities.colStock")}</Th>
                <Th>{t("facilities.colWorkload")}</Th>
                <Th>{t("facilities.colStaffing")}</Th>
                <Th>{t("facilities.colDiagnostics")}</Th>
                <Th align="right">{t("facilities.colAlerts")}</Th>
                <Th>{t("facilities.colUpdated")}</Th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((s) => {
                const f = s.facility;
                const atRisk = s.stockCounts.stock_out + s.stockCounts.critical + s.stockCounts.high;
                const avg = s.footfall.series.length ? s.footfall.last7Total / 7 : null;
                const pct = avg === null ? null : Math.round((avg / f.opd_capacity_per_day) * 100);
                return (
                  <tr key={f.id} className="hover:bg-slate-50/60">
                    <Td>
                      <Link href={`/facilities/${f.id}`} className="font-medium text-brand-700 hover:underline">
                        {localName(f, locale)}
                      </Link>
                      <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-muted">
                        <span className="font-mono">{f.code}</span>
                        <Badge tone="navy" className="px-1.5 py-0 text-[10px]">{t(`facilityType.${f.facility_type}`)}</Badge>
                        <RiskBadge risk={s.risk} t={t} />
                      </span>
                    </Td>
                    <Td className="text-[13px]">
                      {f.block}
                      <span className="block text-[11px] text-ink-muted">{localName({ name: f.district_name, name_hi: f.district_name_hi }, locale)}</span>
                    </Td>
                    <Td>
                      <Badge tone={opStatusTone[f.operational_status]}>{t(`opStatus.${f.operational_status}`)}</Badge>
                    </Td>
                    <Td align="right">
                      {formatNumber(f.bed_capacity)}
                      <span className="block">
                        <Badge tone={utilizationTone(s.beds.utilization)} className="mt-0.5">
                          {s.beds.occupied}/{s.beds.total - s.beds.outOfService}
                        </Badge>
                      </span>
                    </Td>
                    <Td>
                      {atRisk ? (
                        <Badge tone={s.stockCounts.stock_out + s.stockCounts.critical ? "critical" : "warning"}>{t("facilities.stockIssues", { n: atRisk })}</Badge>
                      ) : (
                        <Badge tone="success">{t("facilities.stockOk")}</Badge>
                      )}
                    </Td>
                    <Td className="text-[13px]">
                      {avg === null ? "—" : t("facilities.workloadValue", { value: Math.round(avg), pct: pct ?? 0 })}
                    </Td>
                    <Td>
                      {s.attendance.needsReview ? <Badge tone="warning">{t("facilities.staffingReview")}</Badge> : <Badge tone="success">{t("facilities.staffingOk")}</Badge>}
                    </Td>
                    <Td>
                      {s.diagnostics.unavailable ? (
                        <Badge tone="critical">{t("facilities.diagnosticsDown", { n: s.diagnostics.unavailable })}</Badge>
                      ) : (
                        <Badge tone="success">{t("facilities.diagnosticsOk")}</Badge>
                      )}
                    </Td>
                    <Td align="right">{s.alerts.critical ? <Badge tone="critical">{s.alerts.open}</Badge> : s.alerts.open}</Td>
                    <Td className="whitespace-nowrap text-[12px] text-ink-muted">
                      {formatRelative(f.last_data_update, t)}
                      {(s.hoursSinceUpdate ?? 999) > 48 && (
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
        <Pagination
          page={page}
          pageSize={PAGE_SIZE}
          total={rows.length}
          makeHref={makeHref}
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
