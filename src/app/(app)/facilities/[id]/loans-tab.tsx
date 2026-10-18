import { ReplenishmentActions, TransferLifecycleActions } from "@/components/forms/distribution-forms";
import { Table, Td, Th } from "@/components/ui/data";
import { Badge, Card, CardHeader, EmptyState } from "@/components/ui/primitives";
import { can, canWriteFacility } from "@/lib/auth/permissions";
import { withUser } from "@/lib/db";
import { formatDay, localName } from "@/lib/i18n";
import type { TabCtx } from "./tabs";

interface LoanRow {
  id: string;
  request_code: string;
  status: string;
  is_loan: boolean;
  quantity: number;
  quantity_dispatched: number;
  quantity_received: number;
  from_facility_id: string | null;
  to_facility_id: string;
  medicine: string;
  medicine_hi: string | null;
}

/** Facility-level view of loans, restoration obligations and replenishment. */
export async function LoansTab({ s, user, t, tx, locale }: TabCtx) {
  const f = s.facility;
  const [loans, repl, ledger, dir] = await withUser(user.id, async (q) => [
    await q.query<LoanRow>(
      `select t.id, t.request_code, t.status, t.is_loan, t.quantity, t.quantity_dispatched, t.quantity_received, t.from_facility_id, t.to_facility_id,
              m.name as medicine, m.name_hi as medicine_hi
         from public.transfer_requests t join public.medicines m on m.id = t.medicine_id
        where (t.from_facility_id = $1 or t.to_facility_id = $1) order by t.created_at desc limit 30`,
      [f.id],
    ),
    await q.query<{ id: string; request_code: string; purpose: string; status: string; quantity_requested: number; quantity_received: number; medicine: string; medicine_hi: string | null }>(
      `select r.id, r.request_code, r.purpose, r.status, r.quantity_requested, r.quantity_received, m.name as medicine, m.name_hi as medicine_hi
         from public.replenishment_requests r join public.medicines m on m.id = r.medicine_id
        where r.facility_id = $1 and r.status <> 'cancelled' order by r.created_at desc limit 30`,
      [f.id],
    ),
    await q.query<{ id: string; ledger_code: string; lender_facility_id: string; quantity_borrowed: number; quantity_restored: number; status: string; due_date: string; medicine: string; medicine_hi: string | null }>(
      `select l.id, l.ledger_code, l.lender_facility_id, l.quantity_borrowed, l.quantity_restored, l.status, l.due_date, m.name as medicine, m.name_hi as medicine_hi
         from public.borrowing_ledger l join public.medicines m on m.id = l.medicine_id
        where l.lender_facility_id = $1 or l.borrower_facility_id = $1 order by l.created_at desc`,
      [f.id],
    ),
    await q.query<{ id: string; name: string; name_hi: string | null }>(`select id, name, name_hi from public.facility_directory()`),
  ]);
  const nm = (id: string | null) => {
    const x = dir.find((d) => d.id === id);
    return x ? localName(x, locale) : "—";
  };
  const admin = can(user, "transfers:review");

  const section = (title: string, rows: LoanRow[]) => (
    <Card>
      <CardHeader title={title} />
      {rows.length === 0 ? (
        <EmptyState title={t("common.noData")} />
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((x) => (
            <li key={x.id} className="px-4 py-3 text-[13px] sm:px-5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <span className="font-mono text-[12px]">{x.request_code}</span>
                  {x.is_loan && (
                    <Badge tone="warning" className="ml-1.5">
                      {t("distribution.loan")}
                    </Badge>
                  )}
                  <Badge tone="neutral" className="ml-1.5">
                    {tx(`transferStatus.${x.status}`)}
                  </Badge>
                  <p className="font-medium">
                    {localName({ name: x.medicine, name_hi: x.medicine_hi }, locale)}: {nm(x.from_facility_id)} → {nm(x.to_facility_id)}
                  </p>
                  <p className="text-[12px] text-ink-muted">
                    {t("distribution.approvedQty")} {x.quantity} · {t("distribution.dispatchedQty")} {x.quantity_dispatched} · {t("distribution.receivedQty")} {x.quantity_received}
                  </p>
                </div>
                <TransferLifecycleActions
                  transferId={x.id}
                  status={x.status}
                  quantity={x.quantity}
                  dispatched={x.quantity_dispatched}
                  canDispatch={!!x.from_facility_id && canWriteFacility(user, x.from_facility_id)}
                  canReceive={canWriteFacility(user, x.to_facility_id)}
                  canAdmin={admin}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );

  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-2">
        {section(t("distribution.outgoing"), loans.filter((x) => x.from_facility_id === f.id))}
        {section(t("distribution.incoming"), loans.filter((x) => x.to_facility_id === f.id))}
      </div>
      <Card>
        <CardHeader title={t("distribution.obligations")} subtitle={t("distribution.obligationsHint")} />
        {ledger.length === 0 ? (
          <EmptyState title={t("common.noData")} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>{t("distribution.ledger")}</Th>
                <Th>{t("transfers.medicine")}</Th>
                <Th>{t("common.type")}</Th>
                <Th align="right">{t("distribution.restored")}</Th>
                <Th>{t("common.status")}</Th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((l) => (
                <tr key={l.id}>
                  <Td className="font-mono text-[12px]">{l.ledger_code}</Td>
                  <Td className="text-[13px]">{localName({ name: l.medicine, name_hi: l.medicine_hi }, locale)}</Td>
                  <Td className="text-[12px]">{l.lender_facility_id === f.id ? t("distribution.outgoing") : t("distribution.incoming")}</Td>
                  <Td align="right">
                    {l.quantity_restored}/{l.quantity_borrowed}
                    <span className="block text-[11px] text-ink-muted">
                      {t("distribution.due")}: {formatDay(l.due_date, locale)}
                    </span>
                  </Td>
                  <Td>
                    <Badge tone={l.status === "restored" ? "success" : "warning"}>{tx(`distribution.ledgerStatus.${l.status}`)}</Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <Card>
        <CardHeader title={t("distribution.replenishment")} />
        {repl.length === 0 ? (
          <EmptyState title={t("common.noData")} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>{t("transfers.code")}</Th>
                <Th>{t("transfers.medicine")}</Th>
                <Th align="right">{t("common.quantity")}</Th>
                <Th>{t("common.status")}</Th>
                <Th align="right">{t("common.actions")}</Th>
              </tr>
            </thead>
            <tbody>
              {repl.map((r) => (
                <tr key={r.id}>
                  <Td>
                    <span className="font-mono text-[12px]">{r.request_code}</span>
                    <span className="block text-[11px] text-ink-muted">{tx(`distribution.purpose.${r.purpose}`)}</span>
                  </Td>
                  <Td className="text-[13px]">{localName({ name: r.medicine, name_hi: r.medicine_hi }, locale)}</Td>
                  <Td align="right">
                    {r.quantity_received}/{r.quantity_requested}
                  </Td>
                  <Td>
                    <Badge tone={r.status === "failed" ? "critical" : "info"}>{tx(`distribution.replStatus.${r.status}`)}</Badge>
                  </Td>
                  <Td align="right">
                    <ReplenishmentActions
                      requestId={r.id}
                      status={r.status}
                      outstanding={r.quantity_requested - r.quantity_received}
                      canReceive={canWriteFacility(user, f.id)}
                      canAdmin={admin}
                    />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
