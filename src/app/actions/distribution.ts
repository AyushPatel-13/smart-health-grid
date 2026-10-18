"use server";

import { z } from "zod";
import { can, canWriteFacility } from "@/lib/auth/permissions";
import { withSystem, withUser } from "@/lib/db";
import { isValidDay, todayIST } from "@/lib/dates";
import { loadSnapshots } from "@/lib/data/snapshot";
import { computeDistribution } from "@/lib/distribution/service";
import { fail, ok } from "@/lib/actions/result";
import { refreshAlerts, runAction } from "@/lib/actions/run";

const id = z.guid();
const notes = z.string().trim().max(500).optional().nullable();
const reason = z.string().trim().min(5, "validation.reasonMin").max(500);
const qty = z.number({ error: "validation.positiveInt" }).int("validation.positiveInt").positive("validation.positiveInt").max(1_000_000);

export async function generateRecommendationsAction() {
  return runAction(z.object({}), {}, async (user) => {
    if (!can(user, "transfers:review")) return fail("FORBIDDEN");
    const r = await refreshAlerts(["all"]);
    const recs = "recommendations" in r ? r.recommendations : { total: 0, created: 0, superseded: 0 };
    return ok("distribution.generated", { total: recs.total, created: recs.created });
  });
}

/**
 * Approve: the recommendation is RECOMPUTED from live data on the server
 * (donor, safe lendable quantity, linked replenishment) — client values are
 * never trusted. The SQL function re-validates under lock.
 */
export async function approveRecommendationAction(input: unknown) {
  return runAction(z.object({ recommendationId: id, quantity: qty.optional().nullable(), notes }), input, async (user, d) => {
    if (!can(user, "transfers:review")) return fail("FORBIDDEN");
    const today = todayIST();
    const fresh = await withSystem(async (q) => {
      const [rec] = await q.query<{ dedupe_key: string; decision: string; status: string }>(
        `select dedupe_key, decision, status from public.transfer_recommendations where id = $1`,
        [d.recommendationId],
      );
      if (!rec || rec.status !== "open") return null;
      const recs = await computeDistribution(q, await loadSnapshots(q, { today }), today);
      return { rec, now: recs.find((r) => r.key === rec.dedupe_key) ?? null };
    });
    if (!fresh || !fresh.now || fresh.now.decision !== fresh.rec.decision) {
      await refreshAlerts(["all"]);
      return fail("RECOMMENDATION_STALE");
    }
    const r = fresh.now;
    const loanQty = r.chosen ? Math.min(d.quantity ?? r.proposedQuantity, r.chosen.lendable) : null;
    await withUser(user.id, (q) =>
      q.query(`select public.approve_recommendation($1, $2, $3, $4, $5)`, [
        d.recommendationId, r.chosen?.facilityId ?? null, loanQty, r.replenishmentQuantity, d.notes ?? null,
      ]),
    );
    await refreshAlerts(["all"]);
    return ok("distribution.approved");
  });
}

export async function rejectRecommendationAction(input: unknown) {
  return runAction(z.object({ recommendationId: id, notes: reason }), input, async (user, d) => {
    if (!can(user, "transfers:review")) return fail("FORBIDDEN");
    await withUser(user.id, (q) => q.query(`select public.reject_recommendation($1, $2)`, [d.recommendationId, d.notes]));
    return ok("distribution.rejected");
  });
}

async function transferSides(userId: string, transferId: string) {
  const [t] = await withUser(userId, (q) =>
    q.query<{ from_facility_id: string | null; to_facility_id: string; quantity: number; quantity_dispatched: number }>(
      `select from_facility_id, to_facility_id, quantity, quantity_dispatched from public.transfer_requests where id = $1`,
      [transferId],
    ),
  );
  return t ?? null;
}

export async function dispatchTransferAction(input: unknown) {
  return runAction(z.object({ transferId: id, quantity: qty, notes }), input, async (user, d) => {
    const t = await transferSides(user.id, d.transferId);
    if (!t || !t.from_facility_id || !canWriteFacility(user, t.from_facility_id)) return fail("FORBIDDEN");
    await withUser(user.id, (q) => q.query(`select public.dispatch_transfer($1, $2, $3)`, [d.transferId, d.quantity, d.notes ?? null]));
    await refreshAlerts(["all"]);
    return ok("distribution.dispatched");
  });
}

export async function receiveTransferAction(input: unknown) {
  return runAction(z.object({ transferId: id, quantity: qty, notes }), input, async (user, d) => {
    const t = await transferSides(user.id, d.transferId);
    if (!t || !canWriteFacility(user, t.to_facility_id)) return fail("FORBIDDEN");
    await withUser(user.id, (q) => q.query(`select public.receive_transfer($1, $2, $3)`, [d.transferId, d.quantity, d.notes ?? null]));
    await refreshAlerts(["all"]);
    return ok("distribution.received");
  });
}

export async function failTransferAction(input: unknown) {
  return runAction(z.object({ transferId: id, reason }), input, async (user, d) => {
    if (!can(user, "transfers:review")) return fail("FORBIDDEN");
    await withUser(user.id, (q) => q.query(`select public.fail_transfer($1, $2)`, [d.transferId, d.reason]));
    await refreshAlerts(["all"]);
    return ok("distribution.failed");
  });
}

export async function receiveReplenishmentAction(input: unknown) {
  return runAction(
    z.object({
      requestId: id,
      quantity: qty,
      batchNumber: z.string().trim().regex(/^[A-Za-z0-9/_-]{2,40}$/, "validation.batchFormat"),
      expiryDate: z.string().refine(isValidDay, "validation.invalidDate"),
      notes,
    }),
    input,
    async (user, d) => {
      if (d.expiryDate <= todayIST()) return fail("VALIDATION", { expiryDate: "validation.pastExpiry" });
      await withUser(user.id, (q) =>
        q.query(`select public.receive_replenishment($1, $2, $3, $4::date, $5)`, [d.requestId, d.quantity, d.batchNumber, d.expiryDate, d.notes ?? null]),
      );
      await refreshAlerts(["all"]);
      return ok("distribution.replenishmentReceived");
    },
  );
}

export async function replenishmentStatusAction(input: unknown) {
  return runAction(z.object({ requestId: id, status: z.enum(["approved", "dispatched"]) }), input, async (user, d) => {
    if (!can(user, "transfers:review")) return fail("FORBIDDEN");
    await withUser(user.id, (q) => q.query(`select public.update_replenishment_status($1, $2, $3)`, [d.requestId, d.status, user.id]));
    return ok("common.saved");
  });
}

export async function failReplenishmentAction(input: unknown) {
  return runAction(z.object({ requestId: id, reason }), input, async (user, d) => {
    if (!can(user, "transfers:review")) return fail("FORBIDDEN");
    await withUser(user.id, (q) => q.query(`select public.fail_replenishment($1, $2)`, [d.requestId, d.reason]));
    await refreshAlerts(["all"]);
    return ok("common.saved");
  });
}

export async function reissueReplenishmentAction(input: unknown) {
  return runAction(z.object({ requestId: id }), input, async (user, d) => {
    if (!can(user, "transfers:review")) return fail("FORBIDDEN");
    await withUser(user.id, (q) => q.query(`select public.reissue_replenishment($1, null)`, [d.requestId]));
    await refreshAlerts(["all"]);
    return ok("common.saved");
  });
}

export async function resolveLedgerAction(input: unknown) {
  return runAction(z.object({ ledgerId: id, notes: z.string().trim().min(10, "validation.reasonMin").max(500) }), input, async (user, d) => {
    if (!can(user, "transfers:review")) return fail("FORBIDDEN");
    await withUser(user.id, (q) => q.query(`select public.resolve_ledger($1, $2)`, [d.ledgerId, d.notes]));
    await refreshAlerts(["all"]);
    return ok("common.saved");
  });
}
