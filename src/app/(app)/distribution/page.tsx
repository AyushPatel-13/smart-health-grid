import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { LifecycleStepper } from "@/components/domain/lifecycle";
import { ExpiryOptimizerCard } from "@/components/domain/expiry-card";
import { loadCommitments } from "@/lib/distribution/service";
import { GenerateRecommendationsButton, RecommendationActions, ReplenishmentActions, ResolveLedgerButton, TransferLifecycleActions } from "@/components/forms/distribution-forms";
import { KpiCard, Table, Td, Th } from "@/components/ui/data";
import { Badge, Card, CardBody, CardHeader, EmptyState, Notice, PageHeader } from "@/components/ui/primitives";
import type { DistributionRecommendation } from "@/lib/analytics/distribution";
import { can, canWriteFacility } from "@/lib/auth/permissions";
import { withUser } from "@/lib/db";
import { getFacilityDirectory, getSnapshots } from "@/lib/data/queries";
import { formatDay, formatNumber, localName } from "@/lib/i18n";
import { getI18n } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "Medicine distribution" };

const decisionTone: Record<string, "info" | "teal" | "warning" | "critical"> = {
  normal_replenishment: "info",
  emergency_borrow: "teal",
  emergency_borrow_plus_replenishment: "warning",
  escalate: "critical",
};
const urgencyTone: Record<string, "critical" | "warning" | "info" | "neutral"> = { critical: "critical", high: "warning", medium: "info", low: "neutral" };

export default async function DistributionPage() {
  const { t, tx, locale } = await getI18n();
  const { user, today, snaps } = await getSnapshots();
  const directory = await getFacilityDirectory();
  const name = (id: string | null) => {
    if (!id) return "—";
    const f = directory.find((d) => d.id === id);
    return f ? localName(f, locale) : t("transfers.donorHidden");
  };
  const admin = can(user, "transfers:review");

  const [recs, transfers, events, repl, ledger, stats, committed, active] = await withUser(user.id, async (q) => [
    await q.query<{ id: string; recommendation_code: string; status: string; payload: DistributionRecommendation; created_at: string }>(
      `select id, recommendation_code, status, payload, created_at from public.transfer_recommendations where status = 'open'
        order by case urgency when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end, created_at`,
    ),
    await q.query<{ id: string; request_code: string; status: string; is_loan: boolean; quantity: number; quantity_dispatched: number; quantity_received: number;
      discrepancy_quantity: number; from_facility_id: string | null; to_facility_id: string; medicine: string; medicine_hi: string | null; unit: string; decision: string | null }>(
      `select t.id, t.request_code, t.status, t.is_loan, t.quantity, t.quantity_dispatched, t.quantity_received, t.discrepancy_quantity,
              t.from_facility_id, t.to_facility_id, m.name as medicine, m.name_hi as medicine_hi, m.unit, t.decision
         from public.transfer_requests t join public.medicines m on m.id = t.medicine_id
        where t.status in ('approved', 'dispatched', 'replenishment_pending') or (t.status in ('closed', 'failed') and t.updated_at > now() - interval '3 days')
        order by case t.status when 'dispatched' then 0 when 'approved' then 1 when 'replenishment_pending' then 2 else 3 end, t.updated_at desc`,
    ),
    await q.query<{ transfer_id: string; event: string }>(`select transfer_id, event from public.transfer_events`),
    await q.query<{ id: string; request_code: string; facility_id: string; medicine: string; medicine_hi: string | null; quantity_requested: number;
      quantity_received: number; purpose: string; status: string; due_date: string | null; failure_reason: string | null }>(
      `select r.id, r.request_code, r.facility_id, m.name as medicine, m.name_hi as medicine_hi, r.quantity_requested, r.quantity_received,
              r.purpose, r.status, r.due_date, r.failure_reason
         from public.replenishment_requests r join public.medicines m on m.id = r.medicine_id
        where r.status not in ('received', 'cancelled') order by r.due_date nulls last`,
    ),
    await q.query<{ id: string; ledger_code: string; lender_facility_id: string; borrower_facility_id: string; medicine: string; medicine_hi: string | null;
      quantity_borrowed: number; quantity_restored: number; status: string; due_date: string }>(
      `select l.id, l.ledger_code, l.lender_facility_id, l.borrower_facility_id, m.name as medicine, m.name_hi as medicine_hi,
              l.quantity_borrowed, l.quantity_restored, l.status, l.due_date
         from public.borrowing_ledger l join public.medicines m on m.id = l.medicine_id
        order by case l.status when 'open' then 0 when 'partially_restored' then 0 else 1 end, l.due_date`,
    ),
    await q.query<{ closed30: number; loans30: number; moved30: number; stockouts30: number }>(
      `select (select count(*)::int from public.transfer_requests where status = 'closed' and updated_at > now() - interval '30 days') as closed30,
              (select count(*)::int from public.transfer_requests where is_loan and created_at > now() - interval '30 days') as loans30,
              (select coalesce(sum(quantity_received), 0)::int from public.transfer_requests where received_at > now() - interval '30 days') as moved30,
              (select count(*)::int from public.alerts where category = 'stock_out' and created_at > now() - interval '30 days') as stockouts30`,
    ),
    await loadCommitments(q),
    await q.query<{ k: string }>(`select medicine_id || ':' || coalesce(from_facility_id::text, '') || ':' || to_facility_id as k from public.transfer_requests where status in ('pending', 'approved', 'dispatched')`),
  ]);
  const evBy = new Map<string, string[]>();
  for (const e of events) evBy.set(e.transfer_id, [...(evBy.get(e.transfer_id) ?? []), e.event]);
  const critical = snaps.filter((s) => s.stockCounts.stock_out + s.stockCounts.critical > 0);
  const atRisk = snaps.reduce((a, s) => a + s.stockCounts.stock_out + s.stockCounts.critical + s.stockCounts.high, 0);
  const openLedger = ledger.filter((l) => l.status === "open" || l.status === "partially_restored");
  const overdue = openLedger.filter((l) => l.due_date < today);

  return (
    <>
      <PageHeader title={t("distribution.title")} subtitle={t("distribution.subtitle")} actions={admin && <GenerateRecommendationsButton />} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <KpiCard label={t("distribution.kpiCritical")} value={critical.length} tone={critical.length ? "critical" : "success"} />
        <KpiCard label={t("distribution.kpiAtRisk")} value={atRisk} tone={atRisk ? "warning" : "success"} href="/inventory?risk=at_risk" />
        <KpiCard label={t("distribution.kpiPending")} value={recs.length} tone={recs.length ? "warning" : "neutral"} />
        <KpiCard label={t("distribution.kpiAwaitDispatch")} value={transfers.filter((x) => x.status === "approved").length} tone="info" />
        <KpiCard label={t("distribution.kpiAwaitReceipt")} value={transfers.filter((x) => x.status === "dispatched").length} tone="info" />
        <KpiCard label={t("distribution.kpiReplenishment")} value={repl.length} tone={repl.some((r) => r.status === "failed") ? "critical" : "neutral"} />
        <KpiCard label={t("distribution.kpiObligations")} value={openLedger.length} sub={t("distribution.kpiOverdue", { n: overdue.length })} tone={overdue.length ? "critical" : openLedger.length ? "warning" : "success"} />
        <KpiCard label={t("distribution.kpiHistory")} value={stats[0].closed30} sub={t("distribution.kpiHistorySub", { loans: stats[0].loans30, moved: stats[0].moved30, so: stats[0].stockouts30 })} />
      </div>

      <Card className="mt-4">
        <CardHeader title={t("distribution.recommendations")} subtitle={t("distribution.recommendationsHint")} />
        {recs.length === 0 ? (
          <EmptyState title={t("redistribution.empty")} />
        ) : (
          <ul className="divide-y divide-line">
            {recs.map((row) => {
              const r = row.payload;
              const unit = t(`units.${r.unit as "tablet"}`);
              return (
                <li key={row.id} className="space-y-2 px-4 py-4 sm:px-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge tone={urgencyTone[r.urgency]}>{tx(`distribution.urgency.${r.urgency}`)}</Badge>
                        <Badge tone={decisionTone[r.decision]}>{tx(`distribution.decision.${r.decision}`)}</Badge>
                        <span className="font-mono text-[11px] text-ink-faint">{row.recommendation_code}</span>
                      </div>
                      <p className="mt-1 text-[15px] font-semibold">
                        {r.medicineName} · {name(r.recipient.facilityId)}
                      </p>
                      <p className="text-[12px] text-ink-muted">
                        {t("redistribution.usable")}: {formatNumber(r.recipient.usable)} {unit} · {t("redistribution.demand")}: {formatNumber(r.recipient.dailyDemand)}
                        {t("common.perDay")} · {t("inventory.colDays")}: {r.recipient.daysRemaining ?? "—"} · {t("distribution.required")}: <strong>{formatNumber(r.requiredQuantity)}</strong>
                      </p>
                    </div>
                    {admin && <RecommendationActions id={row.id} proposed={r.proposedQuantity} hasLoan={!!r.chosen} />}
                  </div>
                  <div className="grid gap-3 lg:grid-cols-2">
                    <div className="rounded-lg border border-line p-3 text-[13px]">
                      {r.chosen ? (
                        <>
                          <p className="flex flex-wrap items-center gap-1 font-medium">
                            {name(r.chosen.facilityId)} <ArrowRight className="size-3.5" aria-hidden /> {name(r.recipient.facilityId)}:{" "}
                            {formatNumber(r.proposedQuantity)} {unit}
                          </p>
                          <p className="text-[12px] text-ink-muted">
                            {t("distribution.lendable")}: {formatNumber(r.chosen.lendable)} = {t("distribution.lendableCalc", {
                              usable: r.chosen.usable, committed: r.chosen.committed, safety: r.chosen.safetyStock, own: r.chosen.projectedOwnDemand,
                            })}
                          </p>
                          {r.chosen.distanceKm !== null && (
                            <p className="text-[12px] text-ink-muted">{t("redistribution.transitValue", { km: r.chosen.distanceKm, hours: r.chosen.transitHours })} ({t("distribution.estimateLabel")})</p>
                          )}
                          <p className="mt-1 text-[12px]">
                            {t("redistribution.batches")}: {r.chosen.batches.map((b) => `${b.batchNumber} (${b.quantity}, ${b.expiryDate})`).join(" · ")}
                          </p>
                          {r.lenders.length > 1 && (
                            <p className="mt-1 text-[11px] text-ink-faint">
                              {t("distribution.otherLenders")}: {r.lenders.slice(1).map((l) => `${name(l.facilityId)} (${l.lendable}, ~${l.distanceKm ?? "?"} km)`).join("; ")}
                            </p>
                          )}
                        </>
                      ) : (
                        <p className="text-[12px] text-ink-muted">{r.decision === "escalate" ? t("distribution.noLenderBody") : t("distribution.routineBody")}</p>
                      )}
                      {r.replenishmentQuantity > 0 && (
                        <p className="mt-1 text-[12px] text-amber-800">
                          {t("distribution.linkedReplenishment")}: {formatNumber(r.replenishmentQuantity)} {unit}
                        </p>
                      )}
                    </div>
                    <div className="text-[12px] text-ink-muted">
                      <p className="font-medium text-ink">{t("redistribution.reasons")}</p>
                      <ul className="mt-0.5 space-y-0.5">
                        {r.reasons.map((x, i) => (
                          <li key={i}>• {tx(x.key, x.params)}</li>
                        ))}
                      </ul>
                      {r.limitations.length > 0 && (
                        <>
                          <p className="mt-1 font-medium text-ink">{t("forecasts.limitations")}</p>
                          <ul className="space-y-0.5">
                            {r.limitations.map((x, i) => (
                              <li key={i}>• {tx(x.key, x.params)}</li>
                            ))}
                          </ul>
                        </>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <div className="mt-4">
        <ExpiryOptimizerCard snaps={snaps} committed={committed} today={today} canRequest={admin} existing={new Set(active.map((a) => a.k))} t={t} tx={tx} locale={locale} />
      </div>

      <Card className="mt-4">
        <CardHeader title={t("distribution.inFlight")} />
        {transfers.length === 0 ? (
          <EmptyState title={t("transfers.empty")} />
        ) : (
          <ul className="divide-y divide-line">
            {transfers.map((x) => (
              <li key={x.id} className="space-y-1.5 px-4 py-3 sm:px-5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="text-[13px]">
                    <span className="font-mono text-[12px]">{x.request_code}</span>
                    {x.is_loan && <Badge tone="warning" className="ml-1.5">{t("distribution.loan")}</Badge>}
                    <p className="font-medium">
                      {localName({ name: x.medicine, name_hi: x.medicine_hi }, locale)}: {name(x.from_facility_id)} → {name(x.to_facility_id)}
                    </p>
                    <p className="text-[12px] text-ink-muted">
                      {t("distribution.approvedQty")}: {formatNumber(x.quantity)} · {t("distribution.dispatchedQty")}: {formatNumber(x.quantity_dispatched)} ·{" "}
                      {t("distribution.receivedQty")}: {formatNumber(x.quantity_received)}
                      {x.discrepancy_quantity > 0 && <span className="text-red-700"> · {t("distribution.discrepancy")}: {x.discrepancy_quantity}</span>}
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
                <LifecycleStepper status={x.status} events={evBy.get(x.id) ?? []} tx={tx} compact />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title={t("distribution.replenishment")} />
          {repl.length === 0 ? (
            <EmptyState title={t("common.noData")} />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>{t("transfers.code")}</Th>
                  <Th>{t("common.facility")}</Th>
                  <Th align="right">{t("common.quantity")}</Th>
                  <Th>{t("common.status")}</Th>
                  <Th align="right">{t("common.actions")}</Th>
                </tr>
              </thead>
              <tbody>
                {repl.map((r) => (
                  <tr key={r.id} className="align-top">
                    <Td>
                      <span className="font-mono text-[12px]">{r.request_code}</span>
                      <span className="block text-[11px] text-ink-muted">{tx(`distribution.purpose.${r.purpose}`)}</span>
                    </Td>
                    <Td className="text-[13px]">
                      {name(r.facility_id)}
                      <span className="block text-[11px] text-ink-muted">{localName({ name: r.medicine, name_hi: r.medicine_hi }, locale)}</span>
                    </Td>
                    <Td align="right">
                      {r.quantity_received}/{r.quantity_requested}
                      {r.due_date && (
                        <span className={`block text-[11px] ${r.due_date < today ? "text-red-700" : "text-ink-muted"}`}>
                          {t("distribution.due")}: {formatDay(r.due_date, locale)}
                        </span>
                      )}
                    </Td>
                    <Td>
                      <Badge tone={r.status === "failed" ? "critical" : r.status === "partially_received" ? "warning" : "info"}>{tx(`distribution.replStatus.${r.status}`)}</Badge>
                      {r.failure_reason && <span className="block text-[11px] text-red-700">{r.failure_reason}</span>}
                    </Td>
                    <Td align="right">
                      <ReplenishmentActions
                        requestId={r.id}
                        status={r.status}
                        outstanding={r.quantity_requested - r.quantity_received}
                        canReceive={canWriteFacility(user, r.facility_id)}
                        canAdmin={admin}
                      />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        <Card>
          <CardHeader title={t("distribution.obligations")} subtitle={t("distribution.obligationsHint")} />
          {ledger.length === 0 ? (
            <EmptyState title={t("common.noData")} />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>{t("distribution.ledger")}</Th>
                  <Th>{t("distribution.lenderBorrower")}</Th>
                  <Th align="right">{t("distribution.restored")}</Th>
                  <Th>{t("common.status")}</Th>
                  {admin && (
                    <Th>
                      <span className="sr-only">{t("common.actions")}</span>
                    </Th>
                  )}
                </tr>
              </thead>
              <tbody>
                {ledger.map((l) => {
                  const open = l.status === "open" || l.status === "partially_restored";
                  return (
                    <tr key={l.id} className="align-top">
                      <Td>
                        <span className="font-mono text-[12px]">{l.ledger_code}</span>
                        <span className="block text-[11px] text-ink-muted">{localName({ name: l.medicine, name_hi: l.medicine_hi }, locale)}</span>
                      </Td>
                      <Td className="text-[12px]">
                        {name(l.lender_facility_id)} ⇄ {name(l.borrower_facility_id)}
                      </Td>
                      <Td align="right">
                        {l.quantity_restored}/{l.quantity_borrowed}
                        <span className={`block text-[11px] ${open && l.due_date < today ? "font-semibold text-red-700" : "text-ink-muted"}`}>
                          {t("distribution.due")}: {formatDay(l.due_date, locale)}
                        </span>
                      </Td>
                      <Td>
                        <Badge tone={l.status === "restored" ? "success" : l.status === "written_off" ? "neutral" : open && l.due_date < today ? "critical" : "warning"}>
                          {tx(`distribution.ledgerStatus.${l.status}`)}
                        </Badge>
                        {open && l.due_date < today && <span className="block text-[11px] text-red-700">{t("distribution.overdue")}</span>}
                      </Td>
                      {admin && <Td align="right">{open && <ResolveLedgerButton ledgerId={l.id} />}</Td>}
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
      <Notice tone="info" className="mt-4">
        {t("distribution.policy")}{" "}
        <Link href="/redistribution" className="underline">
          {t("nav.redistribution")}
        </Link>
      </Notice>
      {critical.length > 0 && (
        <Card className="mt-4">
          <CardHeader title={t("distribution.kpiCritical")} />
          <CardBody>
            <ul className="flex flex-wrap gap-2">
              {critical.map((s) => (
                <li key={s.facility.id}>
                  <Link href={`/facilities/${s.facility.id}?tab=inventory`}>
                    <Badge tone="critical">
                      {localName(s.facility, locale)}: {s.stockCounts.stock_out + s.stockCounts.critical}
                    </Badge>
                  </Link>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}
    </>
  );
}
