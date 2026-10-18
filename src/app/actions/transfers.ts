"use server";

import { randomBytes } from "node:crypto";
import { z } from "zod";
import { can, canWriteFacility } from "@/lib/auth/permissions";
import { withUser } from "@/lib/db";
import { todayIST } from "@/lib/dates";
import { loadSnapshots, toStockPositions } from "@/lib/data/snapshot";
import { recommendTransfers } from "@/lib/analytics/redistribution";
import { expiryOptimizer } from "@/lib/analytics/expiry";
import { loadCommitments } from "@/lib/distribution/service";
import { audit } from "@/lib/actions/audit";
import { fail, ok } from "@/lib/actions/result";
import { refreshAlerts, runAction } from "@/lib/actions/run";
import { reviewTransferSchema, transferRequestSchema } from "@/lib/validation/schemas";

function requestCode(): string {
  return `TR-${todayIST().replace(/-/g, "")}-${randomBytes(2).toString("hex").toUpperCase()}`;
}

export async function createTransferRequestAction(input: unknown) {
  return runAction(transferRequestSchema, input, async (user, d) => {
    if (!can(user, "transfers:request") || !canWriteFacility(user, d.toFacilityId)) return fail("FORBIDDEN");
    if (d.fromFacilityId && !can(user, "transfers:review")) return fail("FORBIDDEN");
    if (d.fromFacilityId === d.toFacilityId) return fail("SAME_FACILITY");

    await withUser(user.id, async (q) => {
      // Never trust a client-supplied calculation: recompute the recommendation
      // server-side and store that snapshot with the request.
      let calculation: Record<string, unknown> = { source: "manual" };
      let transit: number | null = null;
      let origin = "manual";
      if (d.recommendationKey && can(user, "transfers:review")) {
        const today = todayIST();
        const snaps = await loadSnapshots(q, { today });
        if (d.source === "expiry") {
          const { recs } = expiryOptimizer(toStockPositions(snaps), await loadCommitments(q), today);
          const er = recs.find((r) => r.key === d.recommendationKey);
          if (!er || d.quantity > er.quantity || er.risk.facilityId !== d.fromFacilityId || er.recipientId !== d.toFacilityId) throw new Error("RECOMMENDATION_STALE");
          calculation = { source: "expiry_optimizer", ...er, computedFor: today };
          transit = er.transitHours;
          origin = "recommendation";
        }
        const rec = d.source === "expiry" ? null : recommendTransfers(toStockPositions(snaps), today).find((r) => r.key === d.recommendationKey);
        if (rec) {
          calculation = { ...rec, computedFor: today };
          transit = rec.transitHours;
          origin = "recommendation";
        }
      }
      const rows = await q.query<{ id: string }>(
        `insert into public.transfer_requests
           (request_code, medicine_id, from_facility_id, to_facility_id, quantity, status, origin, justification,
            calculation, estimated_transit_hours, requested_by)
         values ($1, $2, $3, $4, $5, 'pending', $6, $7, $8::jsonb, $9, $10) returning id`,
        [requestCode(), d.medicineId, d.fromFacilityId, d.toFacilityId, d.quantity, origin, d.justification,
          JSON.stringify(calculation), transit, user.id],
      );
      await audit(q, user, "transfer.requested", "transfer_request", rows[0].id, d.toFacilityId, {
        medicine_id: d.medicineId, from: d.fromFacilityId, quantity: d.quantity, origin,
      });
    });
    return ok("transfers.createdOk");
  });
}

export async function reviewTransferAction(input: unknown) {
  return runAction(reviewTransferSchema, input, async (user, d) => {
    if (!can(user, "transfers:review")) return fail("FORBIDDEN");
    const status = await withUser(user.id, async (q) => {
      const rows = await q.query<{ status: string }>(`select public.review_transfer($1, $2, $3, $4, $5) as status`, [
        d.transferId, d.decision === "approve", d.fromFacilityId, d.quantity ?? null, d.notes,
      ]);
      return rows[0].status;
    });
    return ok(status === "approved" ? "transfers.approved" : "transfers.rejected");
  });
}

const idSchema = z.object({ transferId: z.guid() });

export async function completeTransferAction(input: unknown) {
  return runAction(idSchema, input, async (user, d) => {
    if (!can(user, "transfers:review")) return fail("FORBIDDEN");
    const facilities = await withUser(user.id, async (q) => {
      const t = await q.query<{ from_facility_id: string; to_facility_id: string }>(
        `select from_facility_id, to_facility_id from public.transfer_requests where id = $1`,
        [d.transferId],
      );
      if (!t[0]) throw new Error("TRANSFER_NOT_FOUND");
      await q.query(`select public.complete_transfer($1)`, [d.transferId]);
      return [t[0].from_facility_id, t[0].to_facility_id];
    });
    // Recalculate alerts for both centres after the stock moved.
    await refreshAlerts(facilities.filter(Boolean));
    return ok("transfers.completed");
  });
}

export async function cancelTransferAction(input: unknown) {
  return runAction(idSchema, input, async (user, d) => {
    await withUser(user.id, async (q) => {
      const rows = await q.query<{ id: string; to_facility_id: string }>(
        `update public.transfer_requests set status = 'cancelled'
          where id = $1 and requested_by = $2 and status = 'pending' returning id, to_facility_id`,
        [d.transferId, user.id],
      );
      if (!rows[0]) throw new Error("TRANSFER_NOT_PENDING");
      await audit(q, user, "transfer.cancelled", "transfer_request", d.transferId, rows[0].to_facility_id);
    });
    return ok("transfers.cancelled");
  });
}
