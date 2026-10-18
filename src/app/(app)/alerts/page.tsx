import type { Metadata } from "next";
import Link from "next/link";
import { alertTitle } from "@/components/domain/alert-text";
import { ALERT_SELECT, type AlertRow } from "@/components/domain/blocks";
import { ManualAlertButton, RunEngineButton } from "@/components/forms/alert-forms";
import { FilterForm, FilterSelect, KpiCard, Pagination, Table, Td, Th } from "@/components/ui/data";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui/primitives";
import { alertStatusTone, severityTone } from "@/components/ui/tones";
import { can } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/user";
import { withUser } from "@/lib/db";
import { getFacilityDirectory } from "@/lib/data/queries";
import { formatRelative, localName } from "@/lib/i18n";
import { getI18n } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "Alerts" };
const PAGE_SIZE = 25;
const CATEGORIES = [
  "stock_out", "stock_risk", "low_stock", "expired_stock", "near_expiry", "bed_capacity", "staffing_gap",
  "diagnostic_unavailable", "diagnostic_stale", "footfall_spike", "stale_data", "manual",
] as const;

export default async function AlertsPage({ searchParams }: PageProps<"/alerts">) {
  const sp = (await searchParams) as Record<string, string | undefined>;
  const { t, tx, locale, dict } = await getI18n();
  const user = await requireUser();
  const status = sp.status ?? "active";
  const page = Math.max(1, Number(sp.page) || 1);

  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace("?", `$${params.length}`));
  };
  if (status === "active") where.push("a.status <> 'resolved'");
  else if (status !== "all") add("a.status = ?", status);
  if (sp.severity) add("a.severity = ?", sp.severity);
  if (sp.category) add("a.category = ?", sp.category);
  if (sp.facility) add("a.facility_id = ?::uuid", sp.facility);
  if (sp.mine === "1") add("a.assigned_to = ?::uuid", user.id);
  const whereSql = where.length ? `where ${where.join(" and ")}` : "";

  const [rows, [{ n }], summary] = await withUser(user.id, async (q) => [
    await q.query<AlertRow>(
      `${ALERT_SELECT} ${whereSql}
        order by case a.status when 'open' then 0 when 'acknowledged' then 1 else 2 end,
                 case a.severity when 'critical' then 0 when 'warning' then 1 else 2 end, a.created_at desc
        limit ${PAGE_SIZE} offset ${(page - 1) * PAGE_SIZE}`,
      params,
    ),
    await q.query<{ n: number }>(`select count(*)::int as n from public.alerts a ${whereSql}`, params),
    await q.query<{ status: string; severity: string; n: number }>(
      `select status, severity, count(*)::int as n from public.alerts group by 1, 2`,
    ),
  ]);
  const facilities = await getFacilityDirectory();
  const count = (st: string[], sev?: string) => summary.filter((s) => st.includes(s.status) && (!sev || s.severity === sev)).reduce((a, s) => a + s.n, 0);
  const manage = can(user, "alerts:manage");
  const qs = (p: number) =>
    `/alerts?${new URLSearchParams({ ...(Object.fromEntries(Object.entries(sp).filter(([, v]) => v)) as Record<string, string>), page: String(p) })}`;

  return (
    <>
      <PageHeader
        title={t("alerts.title")}
        subtitle={t("alerts.subtitle")}
        actions={
          manage && (
            <>
              <RunEngineButton />
              <ManualAlertButton facilities={facilities.map((f) => ({ id: f.id, name: `${localName(f, locale)} (${f.code})` }))} />
            </>
          )
        }
      />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label={t("alerts.critical")} value={count(["open", "acknowledged"], "critical")} tone="critical" href="/alerts?severity=critical" />
        <KpiCard label={t("alertStatus.open")} value={count(["open"])} tone="warning" href="/alerts?status=open" />
        <KpiCard label={t("alertStatus.acknowledged")} value={count(["acknowledged"])} tone="info" href="/alerts?status=acknowledged" />
        <KpiCard label={t("alertStatus.resolved")} value={count(["resolved"])} tone="success" href="/alerts?status=resolved" />
      </div>
      <FilterForm applyLabel={t("common.apply")} resetHref="/alerts" resetLabel={t("common.reset")}>
        <FilterSelect
          name="status"
          label={t("common.status")}
          value={status}
          options={[
            { value: "active", label: `${t("alertStatus.open")} + ${t("alertStatus.acknowledged")}` },
            { value: "open", label: t("alertStatus.open") },
            { value: "acknowledged", label: t("alertStatus.acknowledged") },
            { value: "resolved", label: t("alertStatus.resolved") },
            { value: "all", label: t("common.all") },
          ]}
        />
        <FilterSelect
          name="severity"
          label={t("alerts.severityLabel")}
          value={sp.severity}
          options={[{ value: "", label: t("common.all") }, ...(["critical", "warning", "info"] as const).map((s) => ({ value: s, label: t(`severity.${s}`) }))]}
        />
        <FilterSelect
          name="category"
          label={t("alerts.category")}
          value={sp.category}
          options={[{ value: "", label: t("common.all") }, ...CATEGORIES.map((c) => ({ value: c, label: t(`alerts.categories.${c}`) }))]}
        />
        {facilities.length > 1 && (
          <FilterSelect
            name="facility"
            label={t("common.facility")}
            value={sp.facility}
            options={[{ value: "", label: t("common.all") }, ...facilities.map((f) => ({ value: f.id, label: localName(f, locale) }))]}
          />
        )}
        {manage && (
          <FilterSelect
            name="mine"
            label={t("alerts.assigned")}
            value={sp.mine}
            options={[
              { value: "", label: t("common.all") },
              { value: "1", label: t("alerts.myAssigned") },
            ]}
          />
        )}
      </FilterForm>

      <Card>
        {rows.length === 0 ? (
          <EmptyState title={t("alerts.empty")} />
        ) : (
          <Table caption={t("alerts.title")}>
            <thead>
              <tr>
                <Th>{t("alerts.severityLabel")}</Th>
                <Th>{t("alerts.titleField")}</Th>
                <Th>{t("common.facility")}</Th>
                <Th>{t("common.status")}</Th>
                <Th>{t("alerts.assigned")}</Th>
                <Th>{t("alerts.created")}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id} className="hover:bg-slate-50/60">
                  <Td>
                    <Badge tone={severityTone[a.severity]}>{t(`severity.${a.severity as "info"}`)}</Badge>
                  </Td>
                  <Td className="min-w-[260px]">
                    <Link href={`/alerts/${a.id}`} className="font-medium text-brand-700 hover:underline">
                      {alertTitle(a, locale, tx, dict)}
                    </Link>
                    <span className="block text-[11px] text-ink-muted">
                      {tx(`alerts.categories.${a.category}`)} · {a.source === "manual" ? t("alerts.sourceManual") : t("alerts.sourceRule")}
                    </span>
                  </Td>
                  <Td className="text-[13px]">{localName({ name: a.facility_name, name_hi: a.facility_name_hi }, locale)}</Td>
                  <Td>
                    <Badge tone={alertStatusTone[a.status]}>{t(`alertStatus.${a.status as "open"}`)}</Badge>
                  </Td>
                  <Td className="text-[13px]">{a.assigned_name ?? <span className="text-ink-faint">{t("alerts.unassigned")}</span>}</Td>
                  <Td className="whitespace-nowrap text-[12px] text-ink-muted">{formatRelative(a.created_at, t)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <Pagination
          page={page}
          pageSize={PAGE_SIZE}
          total={n}
          makeHref={qs}
          labels={{
            showing: t("common.showing", { from: (page - 1) * PAGE_SIZE + 1, to: Math.min(n, page * PAGE_SIZE), total: n }),
            previous: t("common.previous"),
            next: t("common.next"),
          }}
        />
      </Card>
    </>
  );
}
