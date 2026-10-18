import type { Metadata } from "next";
import { FilterForm, FilterInput, Pagination, Table, Td, Th } from "@/components/ui/data";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui/primitives";
import { requireRole } from "@/lib/auth/user";
import { withUser } from "@/lib/db";
import { formatDateTime } from "@/lib/i18n";
import { getI18n } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "Audit log" };
const PAGE_SIZE = 30;

export default async function AuditPage({ searchParams }: PageProps<"/audit">) {
  const user = await requireRole("district_admin", "read_only");
  const sp = (await searchParams) as Record<string, string | undefined>;
  const { t, locale } = await getI18n();
  const page = Math.max(1, Number(sp.page) || 1);
  const action = (sp.action ?? "").trim();
  const [rows, [{ n }]] = await withUser(user.id, async (q) => [
    await q.query<{
      id: number; action: string; entity_type: string; entity_id: string | null; details: Record<string, unknown>;
      created_at: string; actor: string | null; actor_role: string | null; facility: string | null;
    }>(
      `select l.id, l.action, l.entity_type, l.entity_id, l.details, l.created_at, p.full_name as actor, l.actor_role,
              h.name as facility
         from public.audit_logs l
         left join public.profiles p on p.id = l.actor_id
         left join public.health_centres h on h.id = l.facility_id
        where ($1 = '' or l.action ilike $1 || '%')
        order by l.created_at desc, l.id desc
        limit ${PAGE_SIZE} offset ${(page - 1) * PAGE_SIZE}`,
      [action],
    ),
    await q.query<{ n: number }>(`select count(*)::int as n from public.audit_logs where ($1 = '' or action ilike $1 || '%')`, [action]),
  ]);
  return (
    <>
      <PageHeader title={t("audit.title")} subtitle={t("audit.subtitle")} />
      <FilterForm applyLabel={t("common.apply")} resetHref="/audit" resetLabel={t("common.reset")}>
        <FilterInput name="action" label={t("audit.action")} value={sp.action} placeholder="inventory. / transfer. / alert." />
      </FilterForm>
      <Card>
        {rows.length === 0 ? (
          <EmptyState title={t("audit.empty")} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>{t("audit.when")}</Th>
                <Th>{t("audit.actor")}</Th>
                <Th>{t("audit.action")}</Th>
                <Th>{t("common.facility")}</Th>
                <Th>{t("audit.detailsCol")}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="align-top">
                  <Td className="whitespace-nowrap text-[12px]">{formatDateTime(r.created_at, locale)}</Td>
                  <Td className="text-[13px]">
                    {r.actor ?? t("audit.system")}
                    {r.actor_role && r.actor_role !== "system" && (
                      <span className="block text-[11px] text-ink-muted">{t(`roles.${r.actor_role as "read_only"}`)}</span>
                    )}
                  </Td>
                  <Td>
                    <Badge tone="info" className="font-mono">{r.action}</Badge>
                    <span className="block text-[11px] text-ink-muted">{r.entity_type}</span>
                  </Td>
                  <Td className="text-[13px]">{r.facility ?? "—"}</Td>
                  <Td className="max-w-md">
                    <code className="block whitespace-pre-wrap break-all text-[11px] text-ink-muted">{JSON.stringify(r.details)}</code>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <Pagination
          page={page}
          pageSize={PAGE_SIZE}
          total={n}
          makeHref={(p) => `/audit?${new URLSearchParams({ ...(action ? { action } : {}), page: String(p) })}`}
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
