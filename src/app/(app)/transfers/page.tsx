import type { Metadata } from "next";
import { LifecycleStepper } from "@/components/domain/lifecycle";
import { TransferLifecycleActions } from "@/components/forms/distribution-forms";
import { CancelTransferButton, RequestStockButton, ReviewTransferButton } from "@/components/forms/transfer-forms";
import { FilterForm, FilterSelect, Table, Td, Th } from "@/components/ui/data";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui/primitives";
import { transferTone } from "@/components/ui/tones";
import { can, canWriteFacility } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/user";
import { withUser } from "@/lib/db";
import { getFacilityDirectory } from "@/lib/data/queries";
import { formatDateTime, formatNumber, localName } from "@/lib/i18n";
import { getI18n } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "Transfer requests" };

interface TransferRow {
  id: string;
  request_code: string;
  medicine_id: string;
  medicine: string;
  medicine_hi: string | null;
  unit: string;
  from_facility_id: string | null;
  to_facility_id: string;
  quantity: number;
  status: string;
  origin: string;
  justification: string;
  review_notes: string | null;
  requested_by: string | null;
  requester: string | null;
  reviewer: string | null;
  created_at: string;
  reviewed_at: string | null;
  completed_at: string | null;
  estimated_transit_hours: number | null;
  quantity_dispatched: number;
  quantity_received: number;
  is_loan: boolean;
}

export default async function TransfersPage({ searchParams }: PageProps<"/transfers">) {
  const sp = (await searchParams) as Record<string, string | undefined>;
  const { t, tx, locale } = await getI18n();
  const user = await requireUser();
  const status = sp.status ?? "";
  const [rows, medicines, events] = await withUser(user.id, async (q) => [
    await q.query<TransferRow>(
      `select tr.id, tr.request_code, tr.medicine_id, m.name as medicine, m.name_hi as medicine_hi, m.unit, tr.from_facility_id,
              tr.to_facility_id, tr.quantity, tr.status, tr.origin, tr.justification, tr.review_notes, tr.requested_by,
              rq.full_name as requester, rv.full_name as reviewer, tr.created_at, tr.reviewed_at, tr.completed_at,
              tr.estimated_transit_hours, tr.quantity_dispatched, tr.quantity_received, tr.is_loan
         from public.transfer_requests tr
         join public.medicines m on m.id = tr.medicine_id
         left join public.profiles rq on rq.id = tr.requested_by
         left join public.profiles rv on rv.id = tr.reviewed_by
        where ($1 = '' or tr.status = $1)
        order by case tr.status when 'pending' then 0 when 'approved' then 1 else 2 end, tr.created_at desc
        limit 100`,
      [status],
    ),
    await q.query<{ id: string; name: string; name_hi: string | null }>(`select id, name, name_hi from public.medicines order by name`),
    await q.query<{ transfer_id: string; event: string }>(`select transfer_id, event from public.transfer_events`),
  ]);
  const directory = await getFacilityDirectory();
  const fname = (id: string | null) => {
    if (!id) return null;
    const f = directory.find((d) => d.id === id);
    return f ? localName(f, locale) : t("transfers.donorHidden");
  };
  const review = can(user, "transfers:review");
  const evBy = new Map<string, string[]>();
  for (const e of events) evBy.set(e.transfer_id, [...(evBy.get(e.transfer_id) ?? []), e.event]);
  const requestable =
    user.role === "facility_staff" ? directory.filter((d) => d.id === user.facilityId) : review ? directory : [];

  return (
    <>
      <PageHeader
        title={t("transfers.title")}
        subtitle={t("transfers.subtitle")}
        actions={
          can(user, "transfers:request") && (
            <RequestStockButton
              facilities={requestable.map((f) => ({ id: f.id, name: localName(f, locale) }))}
              medicines={medicines.map((m) => ({ id: m.id, name: localName(m, locale) }))}
              defaultFacilityId={user.facilityId}
            />
          )
        }
      />
      <FilterForm applyLabel={t("common.apply")} resetHref="/transfers" resetLabel={t("common.reset")}>
        <FilterSelect
          name="status"
          label={t("common.status")}
          value={status}
          options={[
            { value: "", label: t("common.all") },
            ...(["pending", "approved", "dispatched", "replenishment_pending", "closed", "completed", "rejected", "cancelled", "failed"] as const).map((s) => ({ value: s, label: t(`transferStatus.${s}`) })),
          ]}
        />
      </FilterForm>
      <Card>
        {rows.length === 0 ? (
          <EmptyState title={t("transfers.empty")} />
        ) : (
          <Table caption={t("transfers.title")}>
            <thead>
              <tr>
                <Th>{t("transfers.code")}</Th>
                <Th>{t("transfers.medicine")}</Th>
                <Th>{t("transfers.route")}</Th>
                <Th align="right">{t("common.quantity")}</Th>
                <Th>{t("common.status")}</Th>
                <Th>{t("transfers.justification")}</Th>
                <Th align="right">{t("common.actions")}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="align-top">
                  <Td>
                    <span className="font-mono text-[12px]">{r.request_code}</span>
                    <span className="block text-[11px] text-ink-muted">
                      {r.origin === "recommendation" ? t("transfers.originRecommendation") : t("transfers.originManual")}
                    </span>
                    <span className="block text-[11px] text-ink-muted">{formatDateTime(r.created_at, locale)}</span>
                  </Td>
                  <Td className="text-[13px]">{localName({ name: r.medicine, name_hi: r.medicine_hi }, locale)}</Td>
                  <Td className="min-w-[200px] text-[13px]">
                    <span className="block">
                      <span className="text-ink-muted">{t("transfers.from")}: </span>
                      {fname(r.from_facility_id) ?? <Badge tone="warning">{t("transfers.donorToAssign")}</Badge>}
                    </span>
                    <span className="block">
                      <span className="text-ink-muted">{t("transfers.to")}: </span>
                      {fname(r.to_facility_id)}
                    </span>
                    {r.estimated_transit_hours !== null && (
                      <span className="block text-[11px] text-ink-muted">~{formatNumber(r.estimated_transit_hours)} h</span>
                    )}
                  </Td>
                  <Td align="right">
                    {formatNumber(r.quantity)}
                    <span className="block text-[11px] text-ink-muted">{t(`units.${r.unit as "tablet"}`)}</span>
                  </Td>
                  <Td>
                    <Badge tone={transferTone[r.status]}>{t(`transferStatus.${r.status as "pending"}`)}</Badge>
                    {r.is_loan && <Badge tone="warning" className="ml-1">{t("distribution.loan")}</Badge>}
                    {r.quantity_dispatched > 0 && (
                      <span className="block text-[11px] text-ink-muted">
                        {t("distribution.dispatchedQty")}: {r.quantity_dispatched} · {t("distribution.receivedQty")}: {r.quantity_received}
                      </span>
                    )}
                    {r.reviewer && <span className="block text-[11px] text-ink-muted">{t("transfers.reviewedBy")}: {r.reviewer}</span>}
                  </Td>
                  <Td className="max-w-xs text-[12px] text-ink-muted">
                    {r.justification}
                    {r.requester && <span className="block text-[11px]">{t("transfers.requestedBy")}: {r.requester}</span>}
                    <span className="mt-1 block">
                      <LifecycleStepper status={r.status} events={evBy.get(r.id) ?? []} tx={tx} compact />
                    </span>
                    {r.review_notes && (
                      <span className="block text-[11px] text-ink">
                        {t("transfers.reviewNotes")}: {r.review_notes}
                      </span>
                    )}
                  </Td>
                  <Td align="right">
                    <div className="flex flex-col items-end gap-1.5">
                      {review && r.status === "pending" && (
                        <ReviewTransferButton
                          transferId={r.id}
                          currentDonor={r.from_facility_id}
                          quantity={r.quantity}
                          donors={directory.filter((d) => d.id !== r.to_facility_id).map((d) => ({ id: d.id, name: localName(d, locale) }))}
                        />
                      )}
                      <TransferLifecycleActions
                        transferId={r.id}
                        status={r.status}
                        quantity={r.quantity}
                        dispatched={r.quantity_dispatched}
                        canDispatch={!!r.from_facility_id && canWriteFacility(user, r.from_facility_id)}
                        canReceive={canWriteFacility(user, r.to_facility_id)}
                        canAdmin={review}
                      />
                      {r.status === "pending" && r.requested_by === user.id && <CancelTransferButton transferId={r.id} />}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
