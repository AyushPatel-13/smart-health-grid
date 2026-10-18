import { decideDistribution, type DistributionRecommendation } from "../analytics/distribution";
import type { DesiredAlert } from "../engine/alerts";
import type { Queryable } from "../db/types";
import { toStockPositions, type FacilitySnapshot } from "../data/snapshot";

/** Quantity already committed (approved, not yet dispatched) per donor/medicine. */
export async function loadCommitments(q: Queryable): Promise<Map<string, number>> {
  const rows = await q.query<{ from_facility_id: string; medicine_id: string; qty: number }>(
    `select from_facility_id, medicine_id, sum(quantity)::int as qty from public.transfer_requests
      where status = 'approved' and from_facility_id is not null group by 1, 2`,
  );
  return new Map(rows.map((r) => [`${r.from_facility_id}:${r.medicine_id}`, r.qty]));
}

/** Recompute decisions from current data (used for display AND re-validation at approval). */
export async function computeDistribution(q: Queryable, snaps: FacilitySnapshot[], today: string): Promise<DistributionRecommendation[]> {
  // Exclude recipients that already have an in-flight loan for the medicine.
  const inflight = await q.query<{ medicine_id: string; to_facility_id: string }>(
    `select medicine_id, to_facility_id from public.transfer_requests where status in ('pending', 'approved', 'dispatched')`,
  );
  const busy = new Set(inflight.map((r) => `${r.medicine_id}:${r.to_facility_id}`));
  const recs = decideDistribution(toStockPositions(snaps), await loadCommitments(q), today);
  return recs.filter((r) => !busy.has(r.key));
}

/**
 * Persist recommendations (RECOMMENDATION_CREATED). Idempotent per
 * medicine/recipient: an open recommendation is updated in place; stale open
 * ones are marked superseded. Runs in the trusted system context.
 */
export async function refreshRecommendations(q: Queryable, snaps: FacilitySnapshot[], today: string) {
  const recs = await computeDistribution(q, snaps, today);
  const ids = snaps.map((s) => s.facility.id);
  const open = await q.query<{ id: string; dedupe_key: string }>(
    `select id, dedupe_key from public.transfer_recommendations where status = 'open' and recipient_facility_id = any($1::uuid[])`,
    [ids],
  );
  const openBy = new Map(open.map((o) => [o.dedupe_key, o.id]));
  let created = 0;
  for (const r of recs) {
    const values = [
      r.medicineId, r.recipient.facilityId, r.chosen?.facilityId ?? null, r.decision, r.urgency, r.requiredQuantity,
      r.chosen?.lendable ?? null, r.proposedQuantity, r.replenishmentQuantity, JSON.stringify(r),
    ];
    const existing = openBy.get(r.key);
    if (existing) {
      openBy.delete(r.key);
      await q.query(
        `update public.transfer_recommendations set medicine_id = $2, recipient_facility_id = $3, donor_facility_id = $4, decision = $5,
                urgency = $6, required_quantity = $7, lendable_quantity = $8, proposed_quantity = $9, replenishment_quantity = $10,
                payload = $11::jsonb where id = $1`,
        [existing, ...values],
      );
    } else {
      created++;
      await q.query(
        `insert into public.transfer_recommendations (recommendation_code, medicine_id, recipient_facility_id, donor_facility_id, decision,
            urgency, required_quantity, lendable_quantity, proposed_quantity, replenishment_quantity, payload, dedupe_key)
         values ('REC-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8)), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
         on conflict (dedupe_key) where status = 'open' do nothing`,
        [...values, r.key],
      );
    }
  }
  for (const id of openBy.values()) {
    await q.query(`update public.transfer_recommendations set status = 'superseded' where id = $1`, [id]);
  }
  return { created, total: recs.length, superseded: openBy.size };
}

/** Rule alerts for overdue restoration obligations and failed replenishments. */
export async function obligationAlerts(q: Queryable, facilityIds: string[], today: string): Promise<DesiredAlert[]> {
  const overdue = await q.query<{ id: string; ledger_code: string; lender_facility_id: string; borrower: string; medicine: string;
    medicine_hi: string | null; outstanding: number; due_date: string }>(
    `select l.id, l.ledger_code, l.lender_facility_id, hb.name as borrower, m.name as medicine, m.name_hi as medicine_hi,
            l.quantity_borrowed - l.quantity_restored as outstanding, l.due_date
       from public.borrowing_ledger l
       join public.health_centres hb on hb.id = l.borrower_facility_id
       join public.medicines m on m.id = l.medicine_id
      where l.status in ('open', 'partially_restored') and l.due_date < $1::date and l.lender_facility_id = any($2::uuid[])`,
    [today, facilityIds],
  );
  const failed = await q.query<{ id: string; request_code: string; facility_id: string; medicine: string; medicine_hi: string | null;
    outstanding: number; purpose: string; failure_reason: string | null }>(
    `select r.id, r.request_code, r.facility_id, m.name as medicine, m.name_hi as medicine_hi,
            r.quantity_requested - r.quantity_received as outstanding, r.purpose, r.failure_reason
       from public.replenishment_requests r join public.medicines m on m.id = r.medicine_id
      where r.status = 'failed' and r.facility_id = any($1::uuid[])`,
    [facilityIds],
  );
  return [
    ...overdue.map((o) => ({
      facilityId: o.lender_facility_id,
      category: "restoration_overdue",
      severity: "warning" as const,
      resourceType: "borrowing_ledger",
      resourceId: o.id,
      resourceLabel: o.ledger_code,
      title: `${o.outstanding} ${o.medicine} owed back since ${o.due_date}`,
      explanation: `Stock lent to ${o.borrower} (${o.ledger_code}) has not been fully restored; ${o.outstanding} unit(s) outstanding, due ${o.due_date}.`,
      recommendedAction: "Expedite the lender-restoration delivery from the district warehouse or approve a documented resolution.",
      supportingValues: { medicine: o.medicine, medicine_hi: o.medicine_hi ?? o.medicine, qty: o.outstanding, due: o.due_date, ledger: o.ledger_code },
      dedupeKey: `restoration_overdue:${o.lender_facility_id}:${o.id}`,
    })),
    ...failed.map((f) => ({
      facilityId: f.facility_id,
      category: "replenishment_failed",
      severity: "warning" as const,
      resourceType: "replenishment_request",
      resourceId: f.id,
      resourceLabel: f.request_code,
      title: `Replenishment ${f.request_code} failed (${f.medicine})`,
      explanation: `${f.outstanding} unit(s) of ${f.medicine} were not delivered: ${f.failure_reason ?? "reason not recorded"}. Any linked obligation stays open.`,
      recommendedAction: "Re-issue the replenishment request or arrange an alternative source.",
      supportingValues: { medicine: f.medicine, medicine_hi: f.medicine_hi ?? f.medicine, qty: f.outstanding, code: f.request_code },
      dedupeKey: `replenishment_failed:${f.facility_id}:${f.id}`,
    })),
  ];
}
